import type { MessageV2 } from "./message-v2"
import { Instance } from "@/project/instance"
import { Plugin } from "@/plugin"

export namespace SessionLoop {
  type Hook = (input: {
    sessionID: string
    messageID: string
    callID?: string
    agent: string
    messages: MessageV2.WithParts[]
  }) => string | void | Promise<string | void>

  const state = Instance.state(() => ({
    answer: {} as Record<string, true>,
    hooks: {} as Record<string, Hook>,
  }))

  export function enabled(input: { hidden?: boolean }) {
    return input.hidden !== true
  }

  export function answering(sessionID: string) {
    return !!state().answer[sessionID]
  }

  export function allow(sessionID: string) {
    state().answer[sessionID] = true
  }

  export function clear(sessionID: string) {
    delete state().answer[sessionID]
  }

  export function register(id: string, hook: Hook) {
    state().hooks[id] = hook
    return () => {
      delete state().hooks[id]
    }
  }

  export async function reasons(input: {
    sessionID: string
    messageID: string
    callID?: string
    agent: string
    messages: MessageV2.WithParts[]
  }) {
    const reasons = [] as string[]
    for (const hook of Object.values(state().hooks)) {
      const result = await hook(input)
      if (typeof result === "string" && result.trim()) reasons.push(result.trim())
    }
    const output = await Plugin.trigger("experimental.session.exit", input, { reasons: [] as string[] })
    return [...reasons, ...output.reasons.filter((item) => item.trim()).map((item) => item.trim())]
  }
}
