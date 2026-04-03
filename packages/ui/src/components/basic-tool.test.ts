import { describe, expect, test } from "bun:test"
import { body, head } from "./basic-tool"

describe("basic tool fallback", () => {
  test("completed title overrides the raw fallback label", () => {
    expect(
      head({
        called: "Called `custom`",
        title: "custom title",
        status: "completed",
        input: { description: "run custom tool" },
      }).title,
    ).toBe("custom title")
  })

  test("pending and running tools keep the generic label", () => {
    expect(head({ called: "Called `custom`", title: "custom title", status: "pending" }).title).toBe("Called `custom`")
    expect(head({ called: "Called `custom`", title: "custom title", status: "running" }).title).toBe("Called `custom`")
  })

  test("completed output is surfaced by the fallback renderer logic", () => {
    expect(body("completed", "done\nnext")).toBe("done\nnext")
  })

  test("missing output keeps the fallback body empty", () => {
    expect(body("completed", "")).toBeUndefined()
    expect(body("completed", "   ")).toBeUndefined()
    expect(body("completed", undefined)).toBeUndefined()
  })
})
