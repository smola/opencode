
# OpenCode Sandboxing

## Configuration

Per agent, e.g. in agent.md front-matter:

```yaml
sandbox:
  enabled: true
  read-only: true
  network: false
```

Fields:

- `enabled` (boolean): whether sandbox is enabled.
- `read-only` (boolean): if `true`, all file-system is read-only.
- `network` (boolean): if `false`, the sandbox will have no networking.

## Implementation

- Currently implemented for linux using `bubblewrap` (command: `bwrap`).
- When sandbox is enabled, the Bash tool will delegate the execution of the command to be run within the `bwrap` sandbox.

