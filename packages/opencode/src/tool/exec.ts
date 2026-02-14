import z from "zod"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./exec.txt"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag.ts"
import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"
import { sandboxConfig, spawn } from "@/sandbox/sandbox"
import { Filesystem } from "@/util/filesystem"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

type ExecParams = {
  command: string[]
  timeout?: number
  workdir?: string
  description: string
}

export const ExecTool = Tool.define("exec", async (initCtx) => {
  const sandbox = sandboxConfig(initCtx?.agent)

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z
        .array(z.string())
        .min(1)
        .describe("Command vector in argv format: [binary, ...args]"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of changing directories in command arguments.`,
        )
        .optional(),
      description: z.string().describe("Clear, concise description of what this command does in 5-10 words."),
    }),
    async execute(params: ExecParams, ctx) {
      const cwd = params.workdir || Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const binary = params.command[0]
      const args = params.command.slice(1)
      if (!binary) throw new Error("Invalid command vector: missing binary")

      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)

      if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(binary)) {
        for (const arg of args) {
          if (arg.startsWith("-") || (binary === "chmod" && arg.startsWith("+"))) continue
          const resolved = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg)
          if (Instance.containsPath(resolved)) continue
          const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
          directories.add(dir)
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => path.join(dir, "*"))
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      const arity = BashArity.prefix(params.command).join(" ") + " *"
      await ctx.ask({
        permission: "exec",
        patterns: [params.command.join(" ")],
        always: [arity],
        metadata: {},
      })

      const shellEnv = await Plugin.trigger("shell.env", { cwd }, { env: {} })
      const proc = spawn(
        binary,
        args,
        {
          cwd,
          env: {
            ...process.env,
            ...shellEnv.env,
            OPENCODE_SESSION_ID: ctx.sessionID,
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
        sandbox,
      )

      let output = ""
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false
      const kill = async () => {
        if (exited) return
        proc.kill()
      }

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []
      if (timedOut) resultMetadata.push(`exec tool terminated command after exceeding timeout ${timeout} ms`)
      if (aborted) resultMetadata.push("User aborted the command")
      if (resultMetadata.length > 0) {
        output += "\n\n<exec_metadata>\n" + resultMetadata.join("\n") + "\n</exec_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
