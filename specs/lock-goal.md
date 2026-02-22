# Goal Lock Tool (`lock_goal`)

## Goal

Add one new built-in tool that lets an agent lock itself to a concrete goal with an executable exit criterion:

- `lock_goal(goal, verify_command)`

This spec depends on `specs/the-loop.md`.

- It does **not** introduce a new `exit` tool.
- It reuses the existing `ExitLoop` tool defined by the loop spec.
- `lock_goal` works by installing session-scoped state that hooks `ExitLoop`.

The feature is **not enabled by default**.

## Requirements

### 1) Availability

- The feature is disabled unless explicitly enabled via experimental config flag.
- `lock_goal` is available only when the feature flag is enabled.
- `ExitLoop` availability continues to be defined by `specs/the-loop.md`.
- When the feature is disabled, no goal-lock behavior is attached to `ExitLoop`.

### 2) `lock_goal`

Parameters:

- `goal` (string): natural-language objective.
- `verify_command` (string): bash command used to verify completion.

Behavior:

- Stores a per-session goal-lock state with:
  - goal text
  - verify command
- Replaces any existing goal lock for the session.
- Registers or updates the session's `ExitLoop` hook using that stored state.
- Returns metadata confirming the session is goal-locked.

### 3) Locked session behavior

This spec relies on the runtime model from `specs/the-loop.md`.

- The agent is already running inside the loop described there.
- Goal lock does not add a separate exit mechanism.
- Goal lock changes whether `ExitLoop` is allowed to succeed for the session.
- The agent must keep using tools until `ExitLoop` is allowed by the goal-lock hook and the normal loop exit flow completes.

### 4) `ExitLoop` hook behavior

When a session has an active goal lock and `ExitLoop` is invoked:

- The goal-lock hook runs the stored `verify_command` in shell context.
- Before running `verify_command`, it must go through the same permission prompt flow as the `bash` tool (same permission type and matching behavior).
- If the command exits with code `0`:
  - clear the goal lock for the session
  - allow `ExitLoop` to continue through the normal success path from `specs/the-loop.md`
- If the command exits non-zero:
  - keep the session goal-locked
  - deny `ExitLoop`
  - return a denial reason that includes failed verification details so the loop continues working

When a session does not have an active goal lock:

- The goal-lock hook does nothing.
- `ExitLoop` behavior is unchanged from `specs/the-loop.md`.

## Runtime model

- Goal-lock state is session-scoped runtime state.
- No database migration is required.
- The state is consumed by an `ExitLoop` hook, not by a separate tool.

## Config

Add an experimental config switch:

- `experimental.goal_lock_tool: boolean` (default disabled)

When false/omitted:

- `lock_goal` is not exposed
- no goal-lock hook is registered on `ExitLoop`

## Tool output expectations

`lock_goal` output includes:

- human-readable lock confirmation
- goal summary
- verification command summary
- note that completion is enforced through `ExitLoop`

When `ExitLoop` is denied by the goal-lock hook, the denial details should include:

- verification command executed
- exit code
- short stdout/stderr summary (truncated by normal tool truncation pipeline)
- explicit lock status after execution

Successful `ExitLoop` behavior and final-answer control handoff remain defined by `specs/the-loop.md`.

## Testing

Add tests that cover:

1. **Tool gating**
   - `lock_goal` absent when feature disabled
   - `lock_goal` present when enabled
   - no separate `exit` tool is exposed
2. **Session lock lifecycle**
   - `lock_goal` sets lock
   - failed verification through `ExitLoop` keeps lock
   - successful verification through `ExitLoop` clears lock
3. **Loop integration**
   - active goal lock installs behavior on `ExitLoop`
   - failed verification causes `ExitLoop` to return denial reasons and continue the loop
   - successful verification allows normal `ExitLoop` success behavior
   - without an active goal lock, `ExitLoop` behaves exactly as defined by `specs/the-loop.md`
