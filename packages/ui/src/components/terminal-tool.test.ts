import { describe, expect, test } from "bun:test"
import { command, select } from "./tool-render"

describe("terminal tool fallback", () => {
  test("selects terminal rendering from direct presentation metadata", () => {
    expect(select(false, { presentation: { type: "terminal" } })).toBe("terminal")
  })

  test("uses presentation command for the terminal body", () => {
    expect(
      command({
        title: "terraform plan",
        input: {},
        metadata: {
          presentation: {
            type: "terminal",
            command: "terraform plan -out plan.tfplan",
          },
        },
        called: "Called `custom`",
      }),
    ).toBe("terraform plan -out plan.tfplan")
  })

  test("keeps tools without terminal metadata on the generic fallback", () => {
    expect(select(false, {})).toBe("generic")
  })

  test("keeps built-in bash on the named renderer path", () => {
    expect(select(true, { presentation: { type: "terminal" } })).toBe("named")
  })
})
