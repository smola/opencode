import { describe, expect, test } from "bun:test"
import { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { Provider } from "@/provider/provider"
import { GoalLock } from "@/session/goal-lock"
import { SessionLoop } from "@/session/loop"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session"
import { MessageID, SessionID } from "@/session/schema"
import { LockGoalTool } from "@/tool/goal-lock"
import { ExitLoopTool } from "@/tool/loop"
import { ToolRegistry } from "@/tool/registry"
import { tmpdir } from "../fixture/fixture"

function ctx(id: string) {
  return {
    sessionID: SessionID.make(id),
    messageID: MessageID.make("message_test"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

describe("session loop", () => {
  test("ExitLoop is available by default", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("ExitLoop")
      },
    })
  })

  test("ExitLoop approval enables the answer turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const exit = await ExitLoopTool.init()
        const toolCtx = ctx("session_answer")
        const result = await exit.execute({}, toolCtx)
        expect(result.output).toBe("OK: Write your answer to the user.")
        expect(result.metadata.approved).toBe(true)
        expect(SessionLoop.answering(toolCtx.sessionID)).toBe(true)
      },
    })
  })

  test("ExitLoop returns all exit denial reasons", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const offA = SessionLoop.register("a", () => "finish the implementation")
        const offB = SessionLoop.register("b", async () => "run verification")
        try {
          const exit = await ExitLoopTool.init()
          const result = await exit.execute({}, ctx("session_denied"))
          expect(result.metadata.approved).toBe(false)
          expect(result.metadata.reasons).toEqual(["finish the implementation", "run verification"])
          expect(result.output).toContain("finish the implementation")
          expect(result.output).toContain("run verification")
        } finally {
          offA()
          offB()
        }
      },
    })
  })

  test("resolveTools disables tools during the answer turn", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const agent = await Agent.get("build")
        const selected = await Provider.defaultModel()
        const model = await Provider.getModel(selected.providerID, selected.modelID)
        const processor = {
          message: {
            id: "message_test",
          },
          partFromToolCall: () => undefined,
        } as any

        const normal = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [],
          answer: false,
        })
        expect(normal.ExitLoop).toBeDefined()

        SessionLoop.allow(session.id)
        const answer = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [],
          answer: true,
        })
        expect(Object.keys(answer)).toEqual([])
      },
    })
  })
})

describe("goal lock tools", () => {
  test("are not enabled by default", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("lock_goal")
        expect(ids).not.toContain("exit")
      },
    })
  })

  test("are enabled behind experimental.goal_lock_tool", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("lock_goal")
        expect(ids).not.toContain("exit")
      },
    })
  })

  test("lock_goal locks and failed ExitLoop keeps lock", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lock = await LockGoalTool.init()
        const exit = await ExitLoopTool.init()
        const toolCtx = ctx("session_lock_fail")
        await lock.execute(
          {
            goal: "Create marker file",
            verify_command: "test -f marker.txt",
          },
          toolCtx,
        )
        expect(GoalLock.locked(toolCtx.sessionID)).toBe(true)

        const result = await exit.execute({}, toolCtx)
        expect(result.metadata.approved).toBe(false)
        expect(result.metadata.reasons).toHaveLength(1)
        expect(result.output).toContain("verify_command: test -f marker.txt")
        expect(result.output).toContain("lock_status: locked")
        expect(GoalLock.locked(toolCtx.sessionID)).toBe(true)
      },
    })
  })

  test("successful ExitLoop unlocks session", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lock = await LockGoalTool.init()
        const exit = await ExitLoopTool.init()
        const toolCtx = ctx("session_lock_success")
        await lock.execute(
          {
            goal: "Always pass",
            verify_command: "printf ok",
          },
          toolCtx,
        )
        const result = await exit.execute({}, toolCtx)
        expect(result.metadata.approved).toBe(true)
        expect(result.output).toBe("OK: Write your answer to the user.")
        expect(GoalLock.locked(toolCtx.sessionID)).toBe(false)
      },
    })
  })

  test("ExitLoop asks for bash permission before verification", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lock = await LockGoalTool.init()
        const exit = await ExitLoopTool.init()
        const asks: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const toolCtx = {
          ...ctx("session_lock_perm"),
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            asks.push(req)
          },
        }

        await lock.execute(
          {
            goal: "Always pass",
            verify_command: "true",
          },
          toolCtx,
        )

        await exit.execute({}, toolCtx)
        expect(asks.length).toBe(1)
        expect(asks[0].permission).toBe("bash")
        expect(asks[0].patterns).toContain("true")
        expect(asks[0].metadata.command).toBe("true")
        expect(asks[0].metadata.description).toBe("Verify locked goal")
      },
    })
  })

  test("resolveTools keeps ExitLoop and lock_goal available while locked", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const agent = await Agent.get("build")
        const selected = await Provider.defaultModel()
        const model = await Provider.getModel(selected.providerID, selected.modelID)
        const processor = {
          message: {
            id: "message_test",
          },
          partFromToolCall: () => undefined,
        } as any

        GoalLock.clear(session.id)
        const unlocked = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [],
          answer: false,
        })
        expect(unlocked.ExitLoop).toBeDefined()
        expect(unlocked.lock_goal).toBeDefined()

        GoalLock.set({
          sessionID: session.id,
          goal: "x",
          verify_command: "true",
        })
        const locked = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          processor,
          bypassAgentCheck: false,
          messages: [],
          answer: false,
        })
        expect(locked.ExitLoop).toBeDefined()
        expect(locked.lock_goal).toBeDefined()
        expect(locked.exit).toBeUndefined()
      },
    })
  })

  test("ExitLoop stays unchanged without an active lock when feature enabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        experimental: {
          goal_lock_tool: true,
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const exit = await ExitLoopTool.init()
        const result = await exit.execute({}, ctx("session_unlocked"))
        expect(result.metadata.approved).toBe(true)
        expect(result.output).toBe("OK: Write your answer to the user.")
      },
    })
  })
})

describe("tool choice", () => {
  test("ExitLoop cannot be disabled by permission rules", () => {
    const disabled = PermissionNext.disabled(["ExitLoop", "Read"], [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "ExitLoop", pattern: "*", action: "deny" },
      { permission: "Read", pattern: "*", action: "deny" },
    ])

    expect(disabled.has("ExitLoop")).toBe(false)
    expect(disabled.has("Read")).toBe(true)
  })

  test("requires tools while the loop or goal lock is active", () => {
    expect(SessionPrompt.toolChoice({ format: "text", loop: false, locked: false })).toBeUndefined()
    expect(SessionPrompt.toolChoice({ format: "text", loop: true, locked: false })).toBe("required")
    expect(SessionPrompt.toolChoice({ format: "text", loop: false, locked: true })).toBe("required")
    expect(SessionPrompt.toolChoice({ format: "json_schema", loop: false, locked: false })).toBe("required")
  })
})
