import { Instance } from "@/project/instance"

export namespace GoalLock {
  const state = Instance.state(() => {
    return {} as Record<string, { goal: string; verify_command: string }>
  })

  export function get(sessionID: string) {
    return state()[sessionID]
  }

  export function set(input: { sessionID: string; goal: string; verify_command: string }) {
    state()[input.sessionID] = {
      goal: input.goal,
      verify_command: input.verify_command,
    }
  }

  export function clear(sessionID: string) {
    delete state()[sessionID]
  }

  export function locked(sessionID: string) {
    return !!state()[sessionID]
  }
}
