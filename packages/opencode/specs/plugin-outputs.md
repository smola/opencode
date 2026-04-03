# Plugin-defined tool output rendering plan

## Goal

Make a plugin-defined tool render in the UI like the built-in Bash tool: shell-style trigger, collapsible terminal output, copy button, and scrollable `<pre><code>` body.

All paths below are relative to this repo root.

## Delivery constraints

- Land this work as **3 separate git commits**.
- Each numbered step below is exactly **one commit**.
- Do **not** save docs for a later cleanup commit. Each step should include the relevant `packages/web/src/content/docs/plugins.mdx` changes in the same commit.
- Before each commit, run package-local `bun typecheck` and the relevant targeted tests for that step.
- Do not run tests from repo root.
- Keep code changes as localized as possible to reduce rebase pain and git conflicts.
- Avoid unrelated refactors, renames, file moves, or new abstractions unless they are strictly required to satisfy the step.
- Prefer small in-place edits to existing files over broader renderer/tooling cleanup.

## Relevant upstream issues

- `#18585` — plugin tools should respect `metadata({ title })` in the TUI display: https://github.com/anomalyco/opencode/issues/18585
- `#12527` — `fromPlugin` discards custom metadata set via `context.metadata()`: https://github.com/anomalyco/opencode/issues/12527

The first two commits should close the current correctness gaps from those issues. The third commit adds the terminal-specific presentation contract.

## Current blockers

- `packages/ui/src/components/message-part.tsx` selects a renderer only by exact tool name.
- Unknown/plugin tool names fall back to `GenericTool` in `packages/ui/src/components/basic-tool.tsx`.
- `GenericTool` does not render completed tool `output`.
- `GenericTool` does not receive completed `state.title`.
- Plugin/local custom tools created through `@opencode-ai/plugin` still return `Promise<string>` from `execute`, so any presentation hint has to flow through `context.metadata(...)`.
- `packages/opencode/src/tool/registry.ts` currently normalizes plugin tool results to `{ title: "", output, metadata: { truncated, outputPath? } }`, which drops title/metadata set through `context.metadata()`. That is the core of `#12527`.

## 3-commit implementation plan

### 1. Commit 1 — preserve plugin completion metadata in `fromPlugin`

This is the first commit.

#### Goal

- preserve `title` set via `context.metadata({ title })`
- preserve custom `metadata` set via `context.metadata({ metadata })`
- merge truncation metadata on top instead of replacing plugin metadata
- keep the plugin tool API compatible with existing `Promise<string>` tools

#### Code changes

Update `packages/opencode/src/tool/registry.ts` inside `fromPlugin`:

- wrap `toolCtx.metadata`
- accumulate:
  - `liveTitle`
  - `liveMetadata`
- still call the original `toolCtx.metadata(...)` so running-state UI updates continue to work
- on completion, truncate the string result and return the merged final shape

Keep this commit scoped to `fromPlugin` behavior and its direct test/docs coverage. Do not change the plugin package API, other tool implementations, or unrelated registry code.

Recommended result shape:

```ts
{
  title: liveTitle,
  output: truncated.content,
  metadata: {
    ...liveMetadata,
    truncated: truncated.truncated,
    ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
  },
}
```

Mirror the existing truncation merge behavior in `packages/opencode/src/tool/tool.ts` rather than inventing a second variant.

This is preferred over changing plugin `execute` to return a richer object, because plugins should keep working against older OpenCode versions that only accept `Promise<string>`.

#### Tests

Extend `packages/opencode/test/tool/registry.test.ts` with targeted cases that verify:

- `context.metadata({ title })` survives into the completed result
- `context.metadata({ metadata })` survives into the completed result
- truncation metadata is merged with plugin metadata instead of replacing it
- the non-truncated path also preserves metadata correctly

#### Docs in the same commit

Update `packages/web/src/content/docs/plugins.mdx` in the custom tools section to document:

- that plugin tools can call `context.metadata({ title, metadata })`
- that the final completed tool state now preserves both values
- that plugin authors should continue returning a string from `execute`

#### Pre-commit verification

From `packages/opencode`:

- `bun typecheck`
- `bun test test/tool/registry.test.ts`

---

### 2. Commit 2 — make the generic fallback renderer usable

This is the second commit.

#### Goal

- make unknown/plugin tools show completed `title`
- make unknown/plugin tools show completed `output`
- improve the fallback UI before adding any terminal-specific presentation API

#### Code changes

Update `packages/ui/src/components/message-part.tsx` and `packages/ui/src/components/basic-tool.tsx`:

1. Extend `ToolProps` with `title?: string`.
2. Pass `part().state.title` from `message-part.tsx` into tool renderers.
3. Update `GenericTool` to:
   - prefer completed `title` over the raw `Called <tool>` label
   - keep the existing pending/running label behavior
   - render completed `output` in its details area instead of dropping it
4. Keep this fallback body simple and generic in this commit. It does **not** need terminal-specific `<pre><code>` rendering yet.

Keep this commit narrow:

- do not refactor renderer registration
- do not change named/built-in tool renderers
- do not extract new shared UI helpers unless that is the only practical way to add the targeted test coverage

This commit is the practical fix for `#18585`, and it makes plugin tools meaningfully usable even without the final terminal presentation contract.

#### Tests

Add a focused UI unit test file, preferably `packages/ui/src/components/basic-tool.test.ts`, covering:

- completed `title` overrides the raw fallback label
- pending/running tools still use the generic called-tool label
- completed `output` is surfaced by the fallback renderer logic
- missing output still keeps the card collapsed/minimal

Keep the tests helper-level if that is simpler than full component rendering.

#### Docs in the same commit

Update `packages/web/src/content/docs/plugins.mdx` to document the improved fallback behavior:

- generic plugin tool cards now prefer the completed title when present
- plugin tools without a specialized renderer still show their output in the default UI

#### Pre-commit verification

From `packages/ui`:

- `bun typecheck`
- `bun test src/components/basic-tool.test.ts`

---

### 3. Commit 3 — add an explicit terminal presentation contract for plugin tools

This is the third commit.

#### Goal

- let a plugin tool opt into Bash-like terminal rendering without taking over the built-in `bash` tool name
- match the existing Bash output presentation with the smallest possible code change

#### Recommended contract

Use a reserved metadata field for presentation hints:

```ts
context.metadata({
  title: "terraform plan",
  metadata: {
    presentation: {
      type: "terminal",
      command: "terraform plan -out plan.tfplan",
    },
  },
})
```

Notes:

- `type: "terminal"` opts the tool into the Bash-like renderer.
- `command` provides the `$ ...` first line for the terminal body.
- If `command` is absent, the renderer can fall back to `title`, then the existing generic label logic.
- The plugin still returns a plain string from `execute`.

#### Code changes

Update `packages/ui/src/components/message-part.tsx` with the smallest possible delta needed to recognize plugin terminal presentation metadata and render the existing Bash-like UI.

1. Keep explicit tool-name renderers first.
2. If there is no exact renderer match, inspect `metadata.presentation.type`.
3. Route `type: "terminal"` parts to a terminal-style rendering path that matches the current Bash UI.
4. Prefer the least-conflict implementation:
   - first choice: add a small local terminal renderer/helper in the same file if that keeps the diff tight
   - otherwise: duplicate the minimal Bash markup needed for plugin terminal tools rather than doing a broader refactor
5. Only touch the built-in Bash renderer if that is necessary for a very small local reuse change.
6. Keep all non-terminal plugin tools on the improved `GenericTool` from commit 2.

The terminal path should preserve the current Bash affordances:

- copy button
- scrollable terminal body
- `<pre><code>` output block
- ANSI stripping consistent with the current Bash renderer

Do **not** turn this into a general tool-renderer cleanup. The goal is only to add the plugin terminal opt-in path with minimal code churn.

#### Tests

Add focused UI tests, preferably in a new file such as `packages/ui/src/components/terminal-tool.test.ts`, covering:

- a non-`bash` tool with `metadata.presentation.type === "terminal"` selects the terminal renderer
- `command` populates the `$ ...` line
- tools without that metadata still use `GenericTool`
- built-in Bash behavior remains unchanged

Prefer testing the smallest new selection/rendering logic directly; do not extract a helper just for cleanliness.

#### Docs in the same commit

Update `packages/web/src/content/docs/plugins.mdx` to document:

- the reserved `metadata.presentation` field
- the `type: "terminal"` contract
- the optional `command` field
- a complete example showing how a plugin tool opts into terminal rendering while still returning a string result

#### Pre-commit verification

From `packages/ui`:

- `bun typecheck`
- `bun test src/components/basic-tool.test.ts src/components/terminal-tool.test.ts`

## Out of scope for these 3 commits

- changing `@opencode-ai/plugin` so custom tools return structured objects instead of strings
- adding more presentation variants beyond `terminal`
- a separate docs-only or cleanup-only commit
