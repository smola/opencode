import z from "zod"
import { Tool } from "./tool"
import LOCK_DESCRIPTION from "./lock-goal.txt"
import { GoalLock } from "@/session/goal-lock"
import { Plugin } from "@/plugin"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { BashArity } from "@/permission/arity"
import { spawn } from "@/sandbox/sandbox"
import { sandboxConfig } from "@/sandbox/sandbox"
import { SessionLoop } from "@/session/loop"
import { Agent } from "@/agent/agent"

const TIMEOUT = 2 * 60 * 1000

async function verify(input: {
  command: string
  sessionID: string
  callID?: string
  abort: AbortSignal
  sandbox?: ReturnType<typeof sandboxConfig>
}) {
  const cwd = Instance.directory
  const shellEnv = await Plugin.trigger("shell.env", { cwd, sessionID: input.sessionID, callID: input.callID }, { env: {} })
  const proc = spawn(
    input.command,
    {
      shell: Shell.acceptable(),
      cwd,
      env: {
        ...process.env,
        ...shellEnv.env,
        OPENCODE_SESSION_ID: input.sessionID,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
    input.sandbox,
  )

  let output = ""
  proc.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  proc.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  let timedOut = false
  let exited = false
  const kill = () => Shell.killTree(proc, { exited: () => exited })
  if (input.abort.aborted) {
    await kill()
  }
  const abort = () => {
    void kill()
  }
  input.abort.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    void kill()
  }, TIMEOUT)

  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      input.abort.removeEventListener("abort", abort)
    }
    proc.once("exit", () => {
      exited = true
      done()
      resolve()
    })
    proc.once("error", (error) => {
      exited = true
      done()
      reject(error)
    })
  })

  const exit = timedOut ? -1 : (proc.exitCode ?? 1)
  return {
    output,
    exit,
  }
}

const hook = Instance.state(() => ({ ready: false }))

export function enableGoalLock() {
  const state = hook()
  if (state.ready) return
  SessionLoop.register("goal_lock", async (input) => {
    const lock = GoalLock.get(input.sessionID)
    if (!lock) return

    const tokens = lock.verify_command.trim().split(/\s+/).filter(Boolean)
    const arity = BashArity.prefix(tokens).join(" ") + " *"
    await input.ask({
      permission: "bash",
      patterns: [lock.verify_command],
      always: [arity],
      metadata: {
        description: "Verify locked goal",
        command: lock.verify_command,
      },
    })

    const result = await verify({
      command: lock.verify_command,
      sessionID: input.sessionID,
      callID: input.callID,
      abort: input.abort,
      sandbox: sandboxConfig(await Agent.get(input.agent)),
    })

    if (result.exit === 0) {
      GoalLock.clear(input.sessionID)
      return
    }

    return [
      "Goal lock verification failed.",
      `verify_command: ${lock.verify_command}`,
      `exit_code: ${result.exit}`,
      "lock_status: locked",
      "stdout_stderr:",
      result.output || "(empty)",
    ].join("\n")
  })
  state.ready = true
}

export const LockGoalTool = Tool.define("lock_goal", {
  description: LOCK_DESCRIPTION,
  parameters: z.object({
    goal: z.string().min(1).describe("Natural language description of the goal"),
    verify_command: z.string().min(1).describe("Bash command that verifies the goal"),
  }),
  async execute(params, ctx) {
    enableGoalLock()
    GoalLock.set({
      sessionID: ctx.sessionID,
      goal: params.goal,
      verify_command: params.verify_command,
    })
    return {
      title: "Goal locked",
      metadata: {
        locked: true,
        goal: params.goal,
        verify_command: params.verify_command,
      },
      output: [
        "Goal lock enabled.",
        `goal: ${params.goal}`,
        `verify_command: ${params.verify_command}`,
        "Completion is enforced through ExitLoop.",
      ].join("\n"),
    }
  },
})
