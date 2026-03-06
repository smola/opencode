import { beforeEach, describe, expect, test } from "bun:test"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageID } from "@/session/schema"
import { MemoryTable } from "@/memory/memory.sql"
import { Database } from "@/storage/db"
import { GrepMemoryTool, ReadMemoryTool, WriteMemoryTool } from "@/tool/memory"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

beforeEach(async () => {
  await resetDatabase()
})

function key(id: string, time: number) {
  return `${new Date(time).toISOString().slice(0, 16)}-${id}`
}

describe("tool.memory", () => {
  test("writes and reads current session memory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "Hello from memory.",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        const result = await read.execute({ path: "/session/current/note.md" }, ctx)
        expect(result.output).toContain("description: Session note.")
        expect(result.output).toContain("version: 1")
        expect(result.output).toContain("Hello from memory.")
      },
    })
  })

  test("writes author_model from runtime context", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          extra: {
            model: {
              providerID: "openai",
              api: { id: "gpt-5.4" },
            },
          },
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "Hello from memory.",
          },
          ctx,
        )

        const row = Database.use((db) => db.select().from(MemoryTable).get())
        expect(row?.author_model).toBe("openai/gpt-5.4")
      },
    })
  })

  test("reads slashless directory aliases as directories", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "session body",
          },
          ctx,
        )
        await write.execute(
          {
            path: "/workspace/current/state.md",
            version: 1,
            description: "Workspace note.",
            content: "workspace body",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        expect((await read.execute({ path: "/session/current" }, ctx)).output).toContain("note.md # Session note.")
        expect((await read.execute({ path: "/workspace/current" }, ctx)).output).toContain("state.md # Workspace note.")
      },
    })
  })

  test("lists session hierarchy from workspace roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const read = await ReadMemoryTool.init()
        expect((await read.execute({ path: "/workspace/current/" }, ctx)).output).toContain(
          "session/ # Session-scoped memory within this workspace.",
        )

        const workspace = tmp.path.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "")
        expect((await read.execute({ path: `/workspace/${workspace}/` }, ctx)).output).toContain(
          "session/ # Session-scoped memory within this workspace.",
        )
      },
    })
  })

  test("lists empty alias directories without trailing slash", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const read = await ReadMemoryTool.init()
        expect((await read.execute({ path: "/global" }, ctx)).output).toContain("<type>directory</type>")
        expect((await read.execute({ path: "/session/current" }, ctx)).output).toContain("<type>directory</type>")
        expect((await read.execute({ path: "/workspace/current" }, ctx)).output).toContain("<type>directory</type>")
        expect((await read.execute({ path: "/workspace/current/session" }, ctx)).output).toContain("current/")
      },
    })
  })

  test("rejects stale memory versions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/global/note.md",
            version: 1,
            description: "Global note.",
            content: "one",
          },
          ctx,
        )
        await expect(
          write.execute(
            {
              path: "/global/note.md",
              version: 1,
              description: "Global note.",
              content: "two",
            },
            ctx,
          ),
        ).rejects.toThrow("Expected version 2")
      },
    })
  })

  test("supports explicit workspace identifiers using the worktree convention", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/workspace/current/state.md",
            version: 1,
            description: "Workspace note.",
            content: "workspace body",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        const workspace = tmp.path.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "")
        const result = await read.execute({ path: `/workspace/${workspace}/state.md` }, ctx)
        expect(result.output).toContain("workspace body")
      },
    })
  })

  test("rejects explicit workspace session current aliases", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const read = await ReadMemoryTool.init()
        const workspace = tmp.path.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "")
        await expect(read.execute({ path: `/workspace/${workspace}/session/current` }, ctx)).rejects.toThrow("Memory path not found")
      },
    })
  })

  test("rejects non-normalized memory paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const read = await ReadMemoryTool.init()
        await expect(read.execute({ path: "/session//current" }, ctx)).rejects.toThrow("must not contain '.', '..', or duplicate slashes")
        await expect(read.execute({ path: "/session/./current" }, ctx)).rejects.toThrow("must not contain '.', '..', or duplicate slashes")
        await expect(read.execute({ path: "/session/../current" }, ctx)).rejects.toThrow("must not contain '.', '..', or duplicate slashes")
      },
    })
  })

  test("lists session aliases and concrete session keys", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Session.create({})
        const b = await Session.create({})
        const ctx = {
          sessionID: a.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/a.md",
            version: 1,
            description: "A note.",
            content: "a",
          },
          ctx,
        )
        await write.execute(
          {
            path: `/session/${key(b.id, b.time.created)}/b.md`,
            version: 1,
            description: "B note.",
            content: "b",
          },
          {
            ...ctx,
            sessionID: b.id,
          },
        )
        const read = await ReadMemoryTool.init()
        const result = await read.execute({ path: "/session/" }, ctx)
        expect(result.output).toContain("current/ # Alias for the current session memory.")
        expect(result.output).toContain(`${key(a.id, a.time.created)}/ # Memory for a session.`)
        expect(result.output).toContain(`${key(b.id, b.time.created)}/ # Memory for a session.`)
      },
    })
  })

  test("hides empty historical sessions in read listings", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const a = await Session.create({})
        const b = await Session.create({})
        const ctx = {
          sessionID: a.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "session body",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        const session = await read.execute({ path: "/session/" }, ctx)
        expect(session.output).toContain(`${key(a.id, a.time.created)}/ # Memory for a session.`)
        expect(session.output).not.toContain(`${key(b.id, b.time.created)}/ # Memory for a session.`)

        const workspace = await read.execute({ path: "/workspace/current/session/" }, ctx)
        expect(workspace.output).toContain(`${key(a.id, a.time.created)}/ # Session-scoped memory within this workspace.`)
        expect(workspace.output).not.toContain(`${key(b.id, b.time.created)}/ # Session-scoped memory within this workspace.`)
      },
    })
  })

  test("expands current session and workspace at root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "session body",
          },
          ctx,
        )
        await write.execute(
          {
            path: "/workspace/current/state.md",
            version: 1,
            description: "Workspace note.",
            content: "workspace body",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        const result = await read.execute({ path: "/" }, ctx)
        expect(result.output).toContain("global/ # Global memory.")
        expect(result.output).toContain("session/current/ # Alias for the current session memory.")
        expect(result.output).toContain("session/current/note.md # Session note.")
        expect(result.output).toContain("workspace/current/ # Alias for the current workspace memory.")
        expect(result.output).toContain("workspace/current/state.md # Workspace note.")
      },
    })
  })

  test("lists card descriptions in directory entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/note.md",
            version: 1,
            description: "Session note.",
            content: "session body",
          },
          ctx,
        )

        const read = await ReadMemoryTool.init()
        const result = await read.execute({ path: "/session/current/" }, ctx)
        expect(result.output).toContain("note.md # Session note.")
      },
    })
  })

  test("greps recursively from the current session alias", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/session/current/a.md",
            version: 1,
            description: "A note.",
            content: "needle here",
          },
          ctx,
        )
        await write.execute(
          {
            path: "/session/current/dir/b.md",
            version: 1,
            description: "B note.",
            content: "no match\nneedle again",
          },
          ctx,
        )

        const grep = await GrepMemoryTool.init()
        const result = await grep.execute({ path: "/session/current", pattern: "needle" }, ctx)
        expect(result.output).toContain("/session/current/a.md:")
        expect(result.output).toContain("Line 8: needle here")
        expect(result.output).toContain("/session/current/dir/b.md:")
        expect(result.output).toContain("Line 9: needle again")
      },
    })
  })

  test("rejects grep for missing memory path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }

        const grep = await GrepMemoryTool.init()
        await expect(grep.execute({ path: "/session/current/missing", pattern: "needle" }, ctx)).rejects.toThrow(
          "Memory path not found: /session/current/missing",
        )
      },
    })
  })

  test("greps from root across scopes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ctx = {
          sessionID: session.id,
          messageID: MessageID.make(""),
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
        }
        const write = await WriteMemoryTool.init()
        await write.execute(
          {
            path: "/global/g.md",
            version: 1,
            description: "Global note.",
            content: "needle global",
          },
          ctx,
        )
        await write.execute(
          {
            path: "/workspace/current/w.md",
            version: 1,
            description: "Workspace note.",
            content: "needle workspace",
          },
          ctx,
        )

        const grep = await GrepMemoryTool.init()
        const result = await grep.execute({ path: "/", pattern: "needle" }, ctx)
        expect(result.output).toContain("/global/g.md:")
        expect(result.output).toContain("/workspace/current/w.md:")
      },
    })
  })
})
