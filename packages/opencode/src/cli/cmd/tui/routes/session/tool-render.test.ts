import { describe, expect, test } from "bun:test"
import { command, terminal } from "./tool-render"

describe("tui terminal tool rendering", () => {
  test("selects terminal mode from metadata.presentation", () => {
    expect(terminal({ presentation: { type: "terminal" } })).toBe(true)
  })

  test("keeps generic mode without terminal presentation metadata", () => {
    expect(terminal({})).toBe(false)
  })

  test("uses presentation command for the shell line", () => {
    expect(
      command({
        tool: "terraform_plan",
        title: "terraform plan",
        input: {},
        metadata: {
          presentation: {
            type: "terminal",
            command: "terraform plan -out plan.tfplan",
          },
        },
      }),
    ).toBe("terraform plan -out plan.tfplan")
  })

  test("falls back from command to title to tool name", () => {
    expect(command({ tool: "terraform_plan", title: "terraform plan", input: {}, metadata: {} })).toBe("terraform plan")
    expect(command({ tool: "terraform_plan", input: {}, metadata: {} })).toBe("terraform_plan")
  })
})
