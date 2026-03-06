import matter from "gray-matter"
import path from "path"
import { and, eq, isNull } from "drizzle-orm"
import { Instance } from "@/project/instance"
import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import { Session } from "@/session"
import type { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { MemoryTable } from "./memory.sql"

type Scope =
  | { type: "global" }
  | { type: "workspace"; projectID: ProjectID; workspace: string }
  | { type: "session"; projectID: ProjectID; workspace: string; sessionID: SessionID; key: string }

type Card = typeof MemoryTable.$inferSelect
type Dir = { path: string; entries: string[] }
type File = { path: string; content: string }
type Match = { path: string; line: number; text: string }
type Search = { row: Card; path: string; scope: Scope }
type Output = Dir | File
type Target = { scope?: Scope; parts: string[]; dir: boolean }

export namespace Memory {
  export async function read(input: { path: string; sessionID: SessionID }): Promise<Output> {
    const target = await resolve(input.path, input.sessionID)
    if (!target.scope) return root(target.parts, input.sessionID)
    if (target.dir || folder(target.scope, target.parts)) return list(target.scope, target.parts, input.sessionID)
    if (!target.dir) {
      const p = join(target.parts)
      if (!current(target.scope, p) && has(target.scope, p)) return list(target.scope, target.parts, input.sessionID)
      return file(target.scope, target.parts)
    }
    return list(target.scope, target.parts, input.sessionID)
  }

  export async function write(input: {
    path: string
    version: number
    description: string
    content: string
    sessionID: SessionID
    author: string
  }) {
    const target = await resolve(input.path, input.sessionID)
    if (!target.scope || target.dir) throw new Error("Memory path must point to a memory card")
    if (target.scope.type === "session" && target.scope.sessionID !== input.sessionID) {
      throw new Error("WriteMemory can only write to the current session")
    }
    if (target.scope.type === "workspace" && target.scope.projectID !== Instance.project.id) {
      throw new Error("WriteMemory can only write to the current workspace")
    }

    const p = join(target.parts)
    const row = current(target.scope, p)
    const next = row ? row.version + 1 : 1
    if (input.version !== next) {
      throw new Error(
        `Version mismatch for ${input.path}. Expected version ${next}. Use ReadMemory(${JSON.stringify(input.path)}) to read the latest version before updating it.`,
      )
    }

    const now = Date.now()
    const scope = target.scope

    Database.transaction((tx) => {
      if (row) tx.update(MemoryTable).set({ is_current: false }).where(eq(MemoryTable.version_id, row.version_id)).run()
      tx.insert(MemoryTable)
        .values({
          version_id: crypto.randomUUID(),
          card_id: row?.card_id ?? crypto.randomUUID(),
          scope: scope.type,
          path: p,
          session: scope.type === "session" ? scope.sessionID : null,
          project_id: scope.type === "global" ? null : scope.projectID,
          workspace: scope.type === "global" ? null : scope.workspace,
          time_created: row?.time_created ?? now,
          time_updated: now,
          version: input.version,
          is_current: true,
          author_model: input.author,
          description: input.description,
          content: input.content,
        })
        .run()
    })

    return { path: input.path, version: input.version }
  }

  export async function grep(input: { path: string; pattern: string; sessionID: SessionID }) {
    const re = new RegExp(input.pattern, "g")
    const target = await resolve(input.path, input.sessionID)
    return search(target, input.path, re, input.sessionID)
  }

  function current(scope: Scope, p: string) {
    return Database.use((db) =>
      db
        .select()
        .from(MemoryTable)
        .where(and(eq(MemoryTable.is_current, true), ...filters(scope, p)))
        .get(),
    )
  }

  function cards(scope: Scope) {
    return Database.use((db) =>
      db
        .select()
        .from(MemoryTable)
        .where(and(eq(MemoryTable.is_current, true), ...filters(scope)))
        .all(),
    )
  }

  function has(scope: Scope, p: string) {
    const pre = p ? `${p}/` : ""
    return cards(scope).some((row) => row.path.startsWith(pre))
  }

  function exists(scope: Scope, p: string) {
    return !!current(scope, p) || has(scope, p)
  }

  function file(scope: Scope, parts: string[]): File {
    const p = join(parts)
    const row = current(scope, p)
    if (!row) throw new Error(`Memory not found: ${absolute(scope, p)}`)
    return render(row, scope)
  }

  async function list(scope: Scope, parts: string[], sessionID: SessionID): Promise<Output> {
    if (scope.type === "global") return tree(cards(scope), scope, parts)
    if (scope.type === "workspace") return workspace(scope, parts, sessionID)
    return tree(cards(scope), scope, parts)
  }

  async function root(parts: string[], sessionID: SessionID): Promise<Output> {
    if (parts.length === 0) return expandedRoot(sessionID)
    if (parts[0] === "global") return list({ type: "global" }, parts.slice(1), sessionID)
    if (parts[0] === "session") return sessionRoot(parts.slice(1), sessionID)
    if (parts[0] === "workspace") return workspaceRoot(parts.slice(1), sessionID)
    throw new Error(`Memory path not found: /${parts.join("/")}`)
  }

  async function search(target: Target, root: string, re: RegExp, sessionID: SessionID) {
    if (!target.scope) return searchRoot(target.parts, root, re, sessionID)
    if (!target.dir) {
      const p = join(target.parts)
      const row = current(target.scope, p)
      if (row) return searchCards([{ row, path: normalizeRoot(root), scope: target.scope }], re)
      if (!has(target.scope, p)) throw new Error(`Memory path not found: ${normalizeRoot(root)}`)
    }
    return searchScope(target.scope, target.parts, root, re, sessionID)
  }

  async function searchRoot(parts: string[], root: string, re: RegExp, sessionID: SessionID) {
    if (parts.length === 0) {
      const session = await sessionScope(sessionID)
      const workspace = await workspaceScope(Instance.project.id)
      return searchCards(
        [
          ...cards({ type: "global" }).map((row) => ({ row, path: prefix("/global", row.path), scope: { type: "global" } as Scope })),
          ...cards(session).map((row) => ({ row, path: prefix("/session/current", row.path), scope: session })),
          ...cards(workspace).map((row) => ({ row, path: prefix("/workspace/current", row.path), scope: workspace })),
        ],
        re,
      )
    }
    if (parts[0] === "global") return searchScope({ type: "global" }, parts.slice(1), root, re, sessionID)
    if (parts[0] === "session") return searchSessionRoot(parts.slice(1), root, re, sessionID)
    if (parts[0] === "workspace") return searchWorkspaceRoot(parts.slice(1), root, re, sessionID)
    throw new Error(`Memory path not found: /${parts.join("/")}`)
  }

  async function searchSessionRoot(parts: string[], root: string, re: RegExp, sessionID: SessionID) {
    if (parts.length === 0) {
      return searchCards(
        await Promise.all(
          sessionRows().map(async (row) => cardsFor(await sessionScope(row.id), `/${path.posix.join("session", sessionKey(row.id, row.time_created))}`)),
        ).then((all) => all.flat()),
        re,
      )
    }
    throw new Error(`Memory path not found: ${root}`)
  }

  async function searchWorkspaceRoot(parts: string[], root: string, re: RegExp, sessionID: SessionID) {
    if (parts.length === 0) {
      const rows = await workspaceRows()
      return searchCards(
        await Promise.all(rows.map(async (row) => cardsFor(await workspaceScope(row.projectID, row.workspace), `/${path.posix.join("workspace", row.workspace)}`))).then((all) => all.flat()),
        re,
      )
    }
    throw new Error(`Memory path not found: ${root}`)
  }

  async function searchScope(scope: Scope, parts: string[], root: string, re: RegExp, sessionID: SessionID) {
    if (scope.type === "workspace" && parts[0] === "session") return searchWorkspace(scope, parts, root, re, sessionID)
    if (parts.length && !exists(scope, join(parts))) throw new Error(`Memory path not found: ${normalizeRoot(root)}`)
    return searchCards(cardsFor(scope, normalizeRoot(root), join(parts)), re)
  }

  async function searchWorkspace(
    scope: Extract<Scope, { type: "workspace" }>,
    parts: string[],
    root: string,
    re: RegExp,
    sessionID: SessionID,
  ) {
    if (parts[0] !== "session") return searchCards(cardsFor(scope, normalizeRoot(root), join(parts)), re)
    if (parts.length === 1) {
      const rows = sessionRows(scope.projectID)
      return searchCards(
        await Promise.all(
          rows.map(async (row) => cardsFor(await sessionScope(row.id), `${absolute(scope)}/session/${sessionKey(row.id, row.time_created)}`)),
        ).then((all) => all.flat()),
        re,
      )
    }
    if (parts[1] === "current") return searchCards(cardsFor(await sessionScope(sessionID), `${absolute(scope)}/session/current`, join(parts.slice(2))), re)
    const row = sessionRows(scope.projectID).find((item) => sessionKey(item.id, item.time_created) === parts[1])
    if (!row) throw new Error(`Memory path not found: ${absolute(scope, `session/${parts[1]}`)}`)
    return searchCards(cardsFor(await sessionScope(row.id), `${absolute(scope)}/session/${parts[1]}`, join(parts.slice(2))), re)
  }

  function cardsFor(scope: Scope, root: string, base = "") {
    const pre = base ? `${base}/` : ""
    return cards(scope)
      .filter((row) => row.path === base || row.path.startsWith(pre))
      .map((row) => ({ row, path: prefix(root, base ? row.path.slice(pre.length) : row.path), scope }))
  }

  function searchCards(rows: Search[], re: RegExp) {
    const matches = rows.flatMap(({ row, path, scope }) => lines(render(row, scope).content, re).map((match) => ({ ...match, path })))
    if (matches.length === 0) return { matches: [], output: "No memory cards found" }
    const out = [] as string[]
    let file = ""
    for (const match of matches) {
      if (file !== match.path) {
        if (file) out.push("")
        file = match.path
        out.push(`${match.path}:`)
      }
      out.push(`  Line ${match.line}: ${match.text}`)
    }
    return { matches, output: out.join("\n") }
  }

  function lines(content: string, re: RegExp): Omit<Match, "path">[] {
    return content.split(/\r?\n/).flatMap((text, index) => {
      const next = new RegExp(re.source, re.flags)
      if (!next.test(text)) return []
      return [{ line: index + 1, text }]
    })
  }

  function normalizeRoot(input: string) {
    return input.endsWith("/") && input !== "/" ? input.slice(0, -1) : input
  }

  function prefix(root: string, child: string) {
    return child ? `${normalizeRoot(root)}/${child}` : normalizeRoot(root)
  }

  async function expandedRoot(sessionID: SessionID) {
    const session = await sessionScope(sessionID)
    const workspace = await workspaceScope(Instance.project.id)
    const sessionEntries = expand(cards(session), "session/current")
    const workspaceEntries = expand(cards(workspace), "workspace/current")
    return dir(
      "/",
      [
        "global/",
        "session/",
        "session/current/",
        ...sessionEntries,
        "workspace/",
        "workspace/current/",
        ...workspaceEntries,
      ],
      {
        ...aliased(cards(session), "session/current"),
        ...aliased(cards(workspace), "workspace/current"),
      },
    )
  }

  async function sessionRoot(parts: string[], sessionID: SessionID): Promise<Output> {
    if (parts.length === 0) {
      const rows = sessionRowsWithCards()
      return dir(
        "/session",
        ["current/", ...rows.map((row) => `${sessionKey(row.id, row.time_created)}/`)].sort((a, b) => a.localeCompare(b)),
      )
    }
    if (parts[0] === "current") return list(await sessionScope(sessionID), parts.slice(1), sessionID)

    const row = sessionRows().find((item) => sessionKey(item.id, item.time_created) === parts[0])
    if (!row) throw new Error(`Memory path not found: /session/${parts[0]}`)
    return list(await sessionScope(row.id), parts.slice(1), sessionID)
  }

  async function workspaceRoot(parts: string[], sessionID: SessionID): Promise<Output> {
    if (parts.length === 0) {
      const rows = await workspaceRows()
      return dir("/workspace", ["current/", ...rows.map((row) => `${row.workspace}/`)].sort((a, b) => a.localeCompare(b)))
    }
    if (parts[0] === "current") return list(await workspaceScope(Instance.project.id), parts.slice(1), sessionID)

    const rows = await workspaceRows()
    const exact = rows.find((row) => row.workspace === parts.join("/"))
    if (exact) return list(await workspaceScope(exact.projectID, exact.workspace), [], sessionID)

    const prefix = parts.join("/") + "/"
    const next = rows
      .filter((row) => row.workspace.startsWith(prefix))
      .map((row) => row.workspace.slice(prefix.length).split("/")[0] + "/")
    if (next.length) return dir(`/workspace/${parts.join("/")}`, [...new Set(next)].sort((a, b) => a.localeCompare(b)))

    throw new Error(`Memory path not found: /workspace/${parts.join("/")}`)
  }

  async function workspace(scope: Extract<Scope, { type: "workspace" }>, parts: string[], sessionID: SessionID): Promise<Output> {
    if (parts[0] !== "session") {
      const result = tree(cards(scope), scope, parts)
      if ("content" in result || parts.length !== 0) return result
      const desc = Object.fromEntries(
        result.entries.map((entry) => {
          const idx = entry.indexOf(" # ")
          return idx === -1 ? [entry, ""] : [entry.slice(0, idx), entry.slice(idx + 3)]
        }),
      )
      return dir(
        result.path,
        [...new Set([...Object.keys(desc), "session/"])].sort((a, b) => a.localeCompare(b)),
        desc,
      )
    }
    if (parts.length === 1) {
      const rows = sessionRowsWithCards(scope.projectID)
      return dir(
        `${absolute(scope)}/session`,
        ["current/", ...rows.map((row) => `${sessionKey(row.id, row.time_created)}/`)].sort((a, b) => a.localeCompare(b)),
      )
    }
    if (parts[1] === "current") return list(await sessionScope(sessionID), parts.slice(2), sessionID)

    const row = sessionRows(scope.projectID).find((item) => sessionKey(item.id, item.time_created) === parts[1])
    if (!row) throw new Error(`Memory path not found: ${absolute(scope, `session/${parts[1]}`)}`)
    return list(await sessionScope(row.id), parts.slice(2), sessionID)
  }

  function tree(rows: Card[], scope: Scope, parts: string[]): Output {
    const p = join(parts)
    if (p) {
      const row = rows.find((item) => item.path === p)
      if (row) return render(row, scope)
    }
    const prefix = p ? `${p}/` : ""
    const entries = rows
      .filter((row) => row.path.startsWith(prefix))
      .map((row) => row.path.slice(prefix.length))
      .filter(Boolean)
      .map((row) => {
        const idx = row.indexOf("/")
        return idx === -1 ? row : row.slice(0, idx + 1)
      })
    if (entries.length === 0 && p) throw new Error(`Memory directory not found: ${absolute(scope, p)}`)
    return dir(absolute(scope, p), [...new Set(entries)].sort((a, b) => a.localeCompare(b)), descriptions(rows, p))
  }

  function expand(rows: Card[], root: string) {
    return rows
      .flatMap((row) => {
        const parts = row.path.split("/").filter(Boolean)
        return parts.map((_, index) => {
          const next = `${root}/${parts.slice(0, index + 1).join("/")}`
          return index === parts.length - 1 ? next : `${next}/`
        })
      })
      .filter((item, index, all) => all.indexOf(item) === index)
      .sort((a, b) => a.localeCompare(b))
  }

  function descriptions(rows: Card[], root = "") {
    const pre = root ? `${root}/` : ""
    return Object.fromEntries(
      rows
        .filter((row) => row.path === root || row.path.startsWith(pre))
        .map((row) => [root ? row.path.slice(pre.length) : row.path, row.description])
        .filter(([entry]) => entry && !entry.includes("/")),
    )
  }

  function aliased(rows: Card[], root: string) {
    return Object.fromEntries(rows.map((row) => [`${root}/${row.path}`, row.description]))
  }

  function filters(scope: Scope, p?: string) {
    const result = [eq(MemoryTable.scope, scope.type)] as any[]
    if (scope.type === "global") result.push(isNull(MemoryTable.project_id))
    if (scope.type === "workspace") result.push(eq(MemoryTable.project_id, scope.projectID))
    if (scope.type === "session") result.push(eq(MemoryTable.session, scope.sessionID))
    if (p !== undefined) result.push(eq(MemoryTable.path, p))
    return result
  }

  function render(row: Card, scope: Scope): File {
    return {
      path: absolute(scope, row.path),
      content: matter.stringify(row.content, {
        description: row.description,
        "author-model": row.author_model,
        "created-at": stamp(row.time_created),
        "updated-at": stamp(row.time_updated),
        version: row.version,
      }),
    }
  }

  function dir(p: string, entries: string[], desc: Record<string, string> = {}): Dir {
    const root = p.endsWith("/") ? p : `${p}/`
    return {
      path: root,
      entries: entries.map((entry) => `${entry} # ${desc[entry] ?? describe(root, entry)}`),
    }
  }

  function join(parts: string[]) {
    return parts.join("/")
  }

  function folder(scope: Scope, parts: string[]) {
    if (parts.length === 0) return true
    return scope.type === "workspace" && parts[0] === "session"
  }

  function absolute(scope: Scope, p = "") {
    if (scope.type === "global") return p ? `/global/${p}` : "/global"
    if (scope.type === "workspace") return p ? `/workspace/${scope.workspace}/${p}` : `/workspace/${scope.workspace}`
    return p ? `/session/${scope.key}/${p}` : `/session/${scope.key}`
  }

  function describe(root: string, entry: string) {
    const full = path.posix.join(root, entry).replace(/\/$/, "")
    if (full === "/global") return "Global memory."
    if (full === "/session") return "Session-level memory."
    if (full === "/session/current") return "Alias for the current session memory."
    if (full.startsWith("/session/")) return "Memory for a session."
    if (full === "/workspace") return "Workspace-level memory."
    if (full === "/workspace/current") return "Alias for the current workspace memory."
    if (full.endsWith("/session")) return "Session-scoped memory within this workspace."
    if (full.includes("/session/current")) return "Alias for the current session memory."
    if (full.includes("/session/")) return "Session-scoped memory within this workspace."
    if (full.startsWith("/workspace/")) return "Memory for a workspace."
    return "Memory directory."
  }

  async function sessionScope(sessionID: SessionID): Promise<Extract<Scope, { type: "session" }>> {
    const session = await Session.get(sessionID)
    const project = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, session.projectID)).get())
    if (!project) throw new Error(`Project not found for session: ${sessionID}`)
    return {
      type: "session",
      projectID: session.projectID,
      workspace: await workspacePath(project.worktree),
      sessionID: session.id,
      key: sessionKey(session.id, session.time.created),
    }
  }

  async function workspaceScope(projectID: ProjectID, given?: string): Promise<Extract<Scope, { type: "workspace" }>> {
    const project = Database.use((db) => db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get())
    if (!project) throw new Error(`Project not found: ${projectID}`)
    return {
      type: "workspace",
      projectID,
      workspace: given ?? (await workspacePath(project.worktree)),
    }
  }

  async function workspaceRows() {
    const projects = Database.use((db) => db.select().from(ProjectTable).all())
    return Promise.all(
      projects.map(async (row) => ({
        projectID: row.id,
        workspace: await workspacePath(row.worktree),
      })),
    )
  }

  function sessionRows(projectID?: ProjectID) {
    return Database.use((db) => {
      const query = db.select({ id: SessionTable.id, time_created: SessionTable.time_created }).from(SessionTable)
      return projectID ? query.where(eq(SessionTable.project_id, projectID)).all() : query.all()
    })
  }

  function sessionRowsWithCards(projectID?: ProjectID) {
    return sessionRows(projectID).filter((row) =>
      Database.use((db) =>
        db
          .select({ id: MemoryTable.version_id })
          .from(MemoryTable)
          .where(and(eq(MemoryTable.is_current, true), eq(MemoryTable.session, row.id)))
          .get(),
      ),
    )
  }

  async function resolve(input: string, sessionID: SessionID): Promise<Target> {
    const norm = normalize(input)
    if (norm.parts.length === 0) return norm
    if (norm.parts[0] === "global") return { scope: { type: "global" }, parts: norm.parts.slice(1), dir: norm.dir }
    if (norm.parts[0] === "session") {
      if (norm.parts.length === 1) return { parts: ["session"], dir: true }
      if (norm.parts[1] === "current") return { scope: await sessionScope(sessionID), parts: norm.parts.slice(2), dir: norm.dir }
      const row = sessionRows().find((item) => sessionKey(item.id, item.time_created) === norm.parts[1])
      if (!row) throw new Error(`Memory path not found: ${input}`)
      return { scope: await sessionScope(row.id), parts: norm.parts.slice(2), dir: norm.dir }
    }
    if (norm.parts[0] === "workspace") {
      if (norm.parts.length === 1) return { parts: ["workspace"], dir: true }
      if (norm.parts[1] === "current") {
        return resolveWorkspace(await workspaceScope(Instance.project.id), norm.parts.slice(2), sessionID, norm.dir, true)
      }
      const rows = await workspaceRows()
      const rest = norm.parts.slice(1)
      const row = rows
        .map((item) => ({ ...item, parts: item.workspace.split("/") }))
        .filter((item) => item.parts.every((part, index) => rest[index] === part))
        .sort((a, b) => b.parts.length - a.parts.length)[0]
      if (!row) throw new Error(`Memory path not found: ${input}`)
      return resolveWorkspace(await workspaceScope(row.projectID, row.workspace), rest.slice(row.parts.length), sessionID, norm.dir, false)
    }
    throw new Error(`Memory path not found: ${input}`)
  }

  async function resolveWorkspace(
    scope: Extract<Scope, { type: "workspace" }>,
    parts: string[],
    sessionID: SessionID,
    dir: boolean,
    current: boolean,
  ): Promise<Target> {
    if (parts[0] !== "session") return { scope, parts, dir }
    if (parts.length === 1) return { scope, parts, dir: true }
    if (parts[1] === "current") {
      if (!current) throw new Error(`Memory path not found: ${absolute(scope, "session/current")}`)
      return { scope: await sessionScope(sessionID), parts: parts.slice(2), dir }
    }
    const row = sessionRows(scope.projectID).find((item) => sessionKey(item.id, item.time_created) === parts[1])
    if (!row) throw new Error(`Memory path not found: ${absolute(scope, `session/${parts[1]}`)}`)
    return { scope: await sessionScope(row.id), parts: parts.slice(2), dir }
  }

  function normalize(input: string): Target {
    if (!input.startsWith("/")) throw new Error("Memory path must be absolute")
    if (input !== path.posix.normalize(input)) throw new Error("Memory path must not contain '.', '..', or duplicate slashes")
    const dir = input.endsWith("/")
    const parts = input.split("/").filter(Boolean)
    return { parts, dir }
  }

  function stamp(time: number) {
    return new Date(time).toISOString()
  }

  function sessionKey(id: string, time: number) {
    return `${new Date(time).toISOString().slice(0, 16)}-${id}`
  }

  function fallbackWorkspacePath(worktree: string) {
    return worktree.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "") || "global"
  }

  async function workspacePath(worktree: string) {
    return fallbackWorkspacePath(worktree)
  }
}
