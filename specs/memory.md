
# Spec for OpenCode Memory

Memory is arranged in a filesystem-like hierarchy:

```
/                                       # Root
/session/                               # Session-level
/session/current/                       # Current session
/session/YYYY-MM-DDTHH:mm-<session-id>/ # Any session, by creation timestamp and session ID
/workspace/                             # Workspace-level
/workspace/current/                     # Current workspace
/workspace/current/session/current/     # Alias for current session
/workspace/current/session/YYYY-.../    # Other sessions in the current workspace
/workspace/<workspace-path>/            # Any workspace by path, following OpenCode's existing workspace convention
/workspace/<workspace-path>/session/... # Any session in the given workspace
/global/                                # Global memory
```

Memory is arranged in memory cards.
Each memory card is a Markdown file with frontmatter.

```
description: One sentence description of the memory.
author-model: model ID that generated this memory.
created-at: timestamp of creation
updated-at: timestamp to last update
version: version of this memory
---
The text of the memory.
```

Memory is retieved by the tool `ReadMemory(path)`.
Calling `ReadMemory(dir)` will list the memory cards in a directory.
Calling `ReadMemory(file)` will retrieve the content of a memory card.
`ReadMemory` can read memory from all sessions and workspaces.
Some directories are expanded for convenience. In particular, `ReadMemory(/)` includes the normal root entries plus the full contents of `/session/current/` and `/workspace/current/` inline.
Each directory entry is suffixed with ` # description`.
For memory cards, the description is the card description.
For special directories such as `/global/`, `/session/current/`, and `/workspace/current/`, the description is a one-line explanation of that directory alias or scope.

Memory can be searched by the tool `GrepMemory(path, pattern)`.
`GrepMemory` recursively searches all memory cards under the given path.
`pattern` is a JavaScript regular expression source.
Examples:
- `GrepMemory(path="/session/current", pattern="needle")`
- `GrepMemory(path="/", pattern="needle.*something")`
`GrepMemory` returns matching memory cards and matching line numbers.

Memory is stored by the tool `WriteMemory(path, version, description, content)`.
Memory can only be written to the current session, the current workspace, or globally.
`WriteMemory` will automatically generate the remaining frontmatter fields beyond version and description.
`WriteMemory` will refuse to write if the given version is not the number following the previously existing version (or 1 if it's a new memory). If this constraint is violated, the write will be rejected and the agent will be directed to use `ReadMemory` to read the latest version before updating it.

All memories are stored in the main OpenCode sqlite database (respects `XDG_DATA_HOME` if defined).

Main table: `memory`. Schema:
- `version_id`: UUID, primary key (unique for each version)
- `card_id`: UUID, unique for each memory card, same across versions
- `workspace`: String, workspace from which the memory version was created.
- `session`: String, session ID from which the memory version was created.
- `scope`: String, `global`, `workspace`, or `session`.
- `created_at`: Timestamp when the first version was created.
- `updated_at`: Timestamp when the current version was created.
- `version`: Integer, starts at 1.
- `is_current`: Boolean, true if this row is the last version for a given `card_id`.
- `author_model`: String, `<provider>/<model-id>` that generated this memory.
- `description`: String
- `content`: Text blob
