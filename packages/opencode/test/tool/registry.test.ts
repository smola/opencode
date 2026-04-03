import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"

afterEach(async () => {
  await Instance.disposeAll()
})

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}

async function run(src: string) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const opencodeDir = path.join(dir, ".opencode")
      await fs.mkdir(opencodeDir, { recursive: true })

      const toolsDir = path.join(opencodeDir, "tools")
      await fs.mkdir(toolsDir, { recursive: true })

      await Bun.write(path.join(toolsDir, "hello.ts"), src)
    },
  })

  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const defs = await ToolRegistry.tools({
        ...model,
        agent: await Agent.get(await Agent.defaultAgent()),
      })
      const tool = defs.find((item) => item.id === "hello")
      if (!tool) throw new Error(`missing hello tool: ${defs.map((item) => item.id).join(", ")}`)
      const live: { title?: string; metadata?: Record<string, unknown> }[] = []
      const result = await tool.execute(
        {},
        {
          sessionID: SessionID.make("session_test"),
          messageID: MessageID.make("message_test"),
          agent: "test",
          abort: new AbortController().signal,
          messages: [],
          metadata(input) {
            live.push(input)
          },
          async ask() {},
        },
      )
      return { live, result }
    },
  })
}

describe("tool.registry", () => {
  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools with external dependencies without crashing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        )

        await Bun.write(
          path.join(opencodeDir, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        )

        const cowsayDir = path.join(opencodeDir, "node_modules", "cowsay")
        await fs.mkdir(cowsayDir, { recursive: true })
        await Bun.write(
          path.join(cowsayDir, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        )
        await Bun.write(
          path.join(cowsayDir, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        )

        await Bun.write(
          path.join(toolsDir, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("cowsay")
      },
    })
  })

  test("preserves title set through plugin metadata", async () => {
    const result = await run([
      "export default {",
      "  description: 'hello tool',",
      "  args: {},",
      "  execute: async (_, context) => {",
      "    context.metadata({ title: 'hello title' })",
      "    return 'hello world'",
      "  },",
      "}",
      "",
    ].join("\n"))

    expect(result.live).toEqual([{ title: "hello title" }])
    expect(result.result.title).toBe("hello title")
    expect(result.result.metadata).toEqual({ truncated: false })
  })

  test("preserves plugin metadata on completion", async () => {
    const result = await run([
      "export default {",
      "  description: 'hello tool',",
      "  args: {},",
      "  execute: async (_, context) => {",
      "    context.metadata({ metadata: { foo: 'bar', count: 1 } })",
      "    return 'hello world'",
      "  },",
      "}",
      "",
    ].join("\n"))

    expect(result.result.metadata).toEqual({ foo: "bar", count: 1, truncated: false })
  })

  test("merges truncation metadata onto plugin metadata", async () => {
    const result = await run([
      "export default {",
      "  description: 'hello tool',",
      "  args: {},",
      "  execute: async (_, context) => {",
      "    context.metadata({ metadata: { foo: 'bar' } })",
      `    return ${JSON.stringify("x".repeat(60 * 1024))}`,
      "  },",
      "}",
      "",
    ].join("\n"))

    expect(result.result.metadata.foo).toBe("bar")
    expect(result.result.metadata.truncated).toBe(true)
    expect(typeof result.result.metadata.outputPath).toBe("string")
  })

  test("keeps title and metadata in the non-truncated path", async () => {
    const result = await run([
      "export default {",
      "  description: 'hello tool',",
      "  args: {},",
      "  execute: async (_, context) => {",
      "    context.metadata({ title: 'hello title' })",
      "    context.metadata({ metadata: { foo: 'bar', mode: 'small' } })",
      "    return 'hello world'",
      "  },",
      "}",
      "",
    ].join("\n"))

    expect(result.result.title).toBe("hello title")
    expect(result.result.metadata).toEqual({ foo: "bar", mode: "small", truncated: false })
    expect(result.result.output).toBe("hello world")
  })
})
