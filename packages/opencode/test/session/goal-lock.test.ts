import { describe, expect, test } from "bun:test"
import { PermissionNext } from "@/permission/next"
import { Instance } from "@/project/instance"
import { tmpdir } from "../fixture/fixture"
import { ToolRegistry } from "@/tool/registry"
import { ExitLoopTool } from "@/tool/loop"
import { SessionLoop } from "@/session/loop"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session"
import { MessageID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"

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

  test("ExitLoop cannot be disabled by permission rules", () => {
    const disabled = PermissionNext.disabled(["ExitLoop", "Read"], [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "ExitLoop", pattern: "*", action: "deny" },
      { permission: "Read", pattern: "*", action: "deny" },
    ])

    expect(disabled.has("ExitLoop")).toBe(false)
    expect(disabled.has("Read")).toBe(true)
  })

  test("toolChoice requires tools only while the loop is active", () => {
    expect(SessionPrompt.toolChoice({ format: "text", loop: false })).toBeUndefined()
    expect(SessionPrompt.toolChoice({ format: "text", loop: true })).toBe("required")
    expect(SessionPrompt.toolChoice({ format: "json_schema", loop: false })).toBe("required")
  })
})
