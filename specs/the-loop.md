# Spec: The Loop

By default, OpenCode agents run locked in a loop, where every turn they are forced to respond with tool calls.
A tool `ExitLoop` is the main way the agent can break the loop during a single turn to stop and give a final answer to the user.
The `ExitLoop` checks if the agent is allowed to stop working, and if it is, it will answer `OK: Write your answer to the user.` and return control to the agent for a single turn with all tools disabled in that turn.
If the user requested JSON schema output, `StructuredOutput` may still be available in that final turn as the required response mechanism, while all other tools remain disabled.
Plugins, other tools, or other parts of the system, can register hooks for the `ExitLoop` tool.
When `ExitLoop` runs, it runs all the exit hooks. And these hooks have the option to return a string with a reason why the exit is now allowed.
If at least one hook denies exit, the `ExitLoop` will answer back to the model with the list of all reasons it's being denied exit, so that it continues working.
