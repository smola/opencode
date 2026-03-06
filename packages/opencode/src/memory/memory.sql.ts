import { integer, index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"

export const MemoryTable = sqliteTable(
  "memory",
  {
    version_id: text().primaryKey(),
    card_id: text().notNull(),
    scope: text().notNull(),
    path: text().notNull(),
    session: text().references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text().references(() => ProjectTable.id, { onDelete: "cascade" }),
    workspace: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    version: integer().notNull(),
    is_current: integer({ mode: "boolean" }).notNull(),
    author_model: text().notNull(),
    description: text().notNull(),
    content: text().notNull(),
  },
  (table) => [
    index("memory_card_idx").on(table.card_id),
    index("memory_path_idx").on(table.scope, table.path),
    index("memory_session_idx").on(table.session),
    index("memory_project_idx").on(table.project_id),
    index("memory_workspace_idx").on(table.workspace),
  ],
)
