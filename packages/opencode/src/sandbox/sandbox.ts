import z from "zod"
import type { Agent } from "@/agent/agent"
import { spawn as childSpawn, type SpawnOptions } from "child_process"

const Config = z
  .object({
    enabled: z.boolean().optional(),
    "read-only": z.boolean().optional(),
    network: z.boolean().optional(),
  })
  .strict()

type Config = z.infer<typeof Config>

export function sandboxConfig(agent?: Agent.Info) {
  return Config.safeParse(agent?.options?.sandbox).data
}

export function sandboxCommand(input: { sandbox?: Config; shell: string; command: string; cwd: string }) {
  if (process.platform !== "linux") return
  if (!input.sandbox?.enabled) return
  const bwrap = Bun.which("bwrap")
  if (!bwrap) return

  const args = ["--die-with-parent", "--new-session"]
  args.push(input.sandbox["read-only"] ? "--ro-bind" : "--bind", "/", "/")
  args.push("--proc", "/proc", "--dev", "/dev")
  if (input.sandbox.network === false) args.push("--unshare-net")
  args.push("--chdir", input.cwd, input.shell, "-lc", input.command)
  return {
    command: bwrap,
    args,
  }
}

export function spawn(command: string, options: SpawnOptions, sandbox?: Config) {
  const shell = typeof options.shell === "string" ? options.shell : "/bin/sh"
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd()
  const sandboxed = sandboxCommand({
    sandbox,
    shell,
    command,
    cwd,
  })
  if (!sandboxed) return childSpawn(command, options)
  return childSpawn(sandboxed.command, sandboxed.args, {
    ...options,
    shell: false,
  })
}
