import json
import subprocess
import argparse
import sys
import os
import hashlib
import shutil
from datetime import datetime, timezone
from typing import Any, TypedDict
from dataclasses import dataclass


class Case(TypedDict):
    """A test case for the benchmark."""

    id: str
    repo: str
    """Repository identifier (e.g., 'github.com/anomalyco/opencode')."""
    commit: str
    """Commit SHA to checkout in the repository."""
    prompt: str
    """Prompt to give to the agent."""
    allowed_tools: list[str]
    """The allowed tool names (lowercase) for the prompt."""
    flag: str
    """A string that should be found within the final answer for the test to pass."""


@dataclass
class ToolCall:
    """A tool call."""

    tool_name: str
    tool_params: dict[str, Any]

    def __str__(self) -> str:
        if not self.tool_params:
            return f"{self.tool_name}()"
        params = ", ".join(
            f'{k}="{v}"' if isinstance(v, str) else f"{k}={v}"
            for k, v in self.tool_params.items()
        )
        return f"{self.tool_name}({params})"


class TokenUsage(TypedDict):
    """Token usage statistics."""

    input: int
    output: int
    reasoning: int
    cache_read: int
    cache_write: int


class CaseResult(TypedDict):
    """The result of running a case."""

    success: bool
    """Whether the case passed (flag found in final answer)."""
    tool_calls: list[ToolCall]
    """The tool calls from the case."""
    stderr: str
    """The stderr from the case."""
    error: str
    """The error from the case."""
    final_answer: str
    """The final answer from the case."""
    tokens: TokenUsage
    """Token usage for the case."""
    cost: float
    """Total cost in USD for the case."""
    turns: int
    """Number of turns (step_finish events) across all sessions."""
    used_subagents: bool
    """Whether sub-agents (task tool) were used."""


def load_cases(filepath: str) -> list[Case]:
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_repo_id(repo: str) -> tuple[str, str]:
    """Normalize repository identifier to (url, hash)."""
    # Normalize github.com/org/repo to full URL
    if repo.startswith("github.com/"):
        url = f"https://{repo}.git"
    elif repo.startswith("http://") or repo.startswith("https://"):
        url = repo if repo.endswith(".git") else f"{repo}.git"
    else:
        raise ValueError(f"Unsupported repo format: {repo}")

    # Generate hash for directory name
    repo_hash = hashlib.sha256(repo.encode()).hexdigest()[:16]
    return url, repo_hash


def get_or_clone_repo(repo: str, cache_dir: str) -> str:
    """Clone repository if not exists, fetch if it does. Returns repo path."""
    repo_url, repo_hash = normalize_repo_id(repo)
    repo_path = os.path.join(cache_dir, repo_hash)

    if os.path.exists(repo_path):
        # Fetch latest changes
        subprocess.run(
            ["git", "fetch", "--all"],
            cwd=repo_path,
            capture_output=True,
            check=False,
        )
        return repo_path

    # Clone repository
    os.makedirs(cache_dir, exist_ok=True)
    result = subprocess.run(
        ["git", "clone", repo_url, repo_path],
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Failed to clone {repo_url}: {result.stderr}")

    return repo_path


def checkout_commit(repo_path: str, commit: str, work_dir: str) -> str:
    """Create an isolated checkout at specific commit. Returns work directory path."""
    # Ensure work_dir exists
    os.makedirs(work_dir, exist_ok=True)

    # Use short commit hash for directory name
    checkout_path = os.path.join(work_dir, commit[:12])

    # Clean up existing checkout if present
    if os.path.exists(checkout_path):
        # Remove from git worktree list first
        subprocess.run(
            ["git", "worktree", "remove", "--force", checkout_path],
            cwd=repo_path,
            capture_output=True,
            check=False,
        )
        # Ensure directory is removed
        if os.path.exists(checkout_path):
            shutil.rmtree(checkout_path)

    # Create worktree at specific commit
    result = subprocess.run(
        ["git", "worktree", "add", checkout_path, commit],
        cwd=repo_path,
        capture_output=True,
        text=True,
        check=False,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Failed to create worktree at {commit}: {result.stderr}")

    return checkout_path


def cleanup_worktree(repo_path: str, checkout_path: str):
    """Clean up a git worktree."""
    if not os.path.exists(checkout_path):
        return

    # Remove worktree
    subprocess.run(
        ["git", "worktree", "remove", "--force", checkout_path],
        cwd=repo_path,
        capture_output=True,
        check=False,
    )


def run_opencode(
    prompt: str,
    model: str,
    binary_path: str,
    agent: str = "build",
    workdir: str | None = None,
) -> dict[str, Any]:
    cmd = [
        binary_path,
        "run",
        "--agent",
        agent,
        "--format",
        "json",
        "--model",
        model,
        prompt,
    ]

    # Read opencode-for-benchmark.json and set it as environment variable
    config_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "opencode-for-benchmark.json"
    )
    env = os.environ.copy()

    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            env["OPENCODE_CONFIG_CONTENT"] = f.read()

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=False, cwd=workdir, env=env
        )

        # If the command failed (non-zero exit code), we still try to parse stdout/stderr
        # because opencode might return JSON error objects.

        output_lines = result.stdout.strip().split("\n")
        # The output might contain multiple JSON objects (streaming) or just one final one.
        # We are interested in the sequence of events, especially tool calls.

        events = []
        for line in output_lines:
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # print(f"Failed to decode JSON line: {line}", file=sys.stderr)
                pass

        return {
            "success": result.returncode == 0,
            "events": events,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "events": [],
            "stdout": "",
            "stderr": "",
            "returncode": None,
        }


def get_opencode_version() -> str:
    """Get opencode version using git describe."""
    try:
        result = subprocess.run(
            ["git", "describe", "--always", "--dirty"],
            capture_output=True,
            text=True,
            check=False,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        if result.returncode == 0:
            return result.stdout.strip()
        # Fallback to rev-parse if describe fails
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return "unknown"
    except Exception:
        return "unknown"


def dump_output(
    case_id: str,
    session_id: str,
    model: str,
    prompt: str,
    run_result: dict[str, Any],
    agent: str = "build",
    tokens: TokenUsage | None = None,
    cost: float | None = None,
    turns: int | None = None,
    used_subagents: bool | None = None,
    opencode_version: str | None = None,
    repo: str | None = None,
    commit: str | None = None,
    tool_calls: list[ToolCall] | None = None,
    flag_found: bool | None = None,
) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = session_id or "no-session"
    root = os.path.join("benchmarks", "output", case_id)
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, f"{timestamp}-{session}.json")

    # Try to parse stdout as JSONL events
    stdout = run_result.get("stdout", "")
    events = run_result.get("events", [])

    # If we already have parsed events, don't include stdout
    # Otherwise, try to parse stdout as JSONL
    if not events and stdout:
        try:
            parsed_events = []
            for line in stdout.strip().split("\n"):
                if line.strip():
                    parsed_events.append(json.loads(line))
            # If parsing succeeded, use events and clear stdout
            if parsed_events:
                events = parsed_events
                stdout = ""
        except json.JSONDecodeError:
            # Keep stdout as-is if not valid JSONL
            pass
    elif events:
        # We have events, so don't include stdout
        stdout = ""

    payload = {
        "case_id": case_id,
        "session_id": session_id,
        "model": model,
        "agent": agent,
        "prompt": prompt,
        "success": run_result.get("success"),
        "returncode": run_result.get("returncode"),
        "stderr": run_result.get("stderr", ""),
    }

    # Only include stdout if we don't have events
    if stdout:
        payload["stdout"] = stdout

    # Include events if we have them
    if events:
        payload["events"] = events

    if opencode_version:
        payload["opencode_version"] = opencode_version

    if repo:
        payload["repo"] = repo

    if commit:
        payload["commit"] = commit

    if tokens:
        payload["tokens"] = tokens

    if cost is not None:
        payload["cost"] = cost

    if turns is not None:
        payload["turns"] = turns

    if used_subagents is not None:
        payload["used_subagents"] = used_subagents

    if tool_calls is not None:
        payload["tool_calls"] = [str(tc) for tc in tool_calls]

    if flag_found is not None:
        payload["flag_found"] = flag_found

    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)

    return path


def extract_tool_calls(events: list[dict[str, Any]]) -> list[ToolCall]:
    """Extract tool calls from events."""
    tool_calls: list[ToolCall] = []

    for event in events:
        tool_name = None
        params = {}

        # Check for direct "tool_call" type (common in some formats)
        if event.get("type") == "tool_call":
            tool_name = event.get("tool", "unknown")
            params = event.get("params", {})

        # Check for "tool_use" type (seen in debug log)
        elif event.get("type") == "tool_use":
            # The tool name might be in a 'part' object or directly in the event
            part = event.get("part", {})
            tool_name = part.get("tool") or event.get("tool")
            # Parameters are in part.state.input
            state = part.get("state", {})
            params = state.get("input", {})
            if tool_name == "task":
                metadata = state.get("metadata", {})
                session_id = metadata.get("sessionId", "")
                tool_calls.extend(load_subagent_tool_calls(session_id))
                continue
            if tool_name == "task":
                metadata = state.get("metadata", {})
                summary = metadata.get("summary", [])
                for item in summary:
                    summary_tool = item.get("tool")
                    if not summary_tool:
                        continue
                    summary_state = item.get("state", {})
                    summary_params = summary_state.get("input", {})
                    summary_title = summary_state.get("title")
                    if not summary_params and summary_title:
                        summary_params = {"title": summary_title}
                    tool_calls.append(ToolCall(summary_tool.lower(), summary_params))

        # Check for message with tool_calls (standard OpenAI/Anthropic format often wrapped)
        elif "tool_calls" in event:
            for tc in event["tool_calls"]:
                tc_name = tc.get("function", {}).get("name", "unknown")
                tc_params = tc.get("function", {}).get("arguments", {})
                if isinstance(tc_params, str):
                    try:
                        tc_params = json.loads(tc_params)
                    except json.JSONDecodeError:
                        tc_params = {}
                tool_calls.append(ToolCall(tc_name.lower(), tc_params))
            continue

        if tool_name:
            tool_calls.append(ToolCall(tool_name.lower(), params))

    return tool_calls


def load_subagent_tool_calls(session_id: str) -> list[ToolCall]:
    if not session_id:
        return []

    root = os.path.join(
        os.path.expanduser("~"),
        ".local",
        "share",
        "opencode",
        "storage",
    )
    message_root = os.path.join(root, "message", session_id)
    if not os.path.exists(message_root):
        return []

    # Collect messages with timestamps
    messages_with_time: list[tuple[int, str]] = []
    for entry in os.listdir(message_root):
        if not entry.startswith("msg_"):
            continue
        if not entry.endswith(".json"):
            continue
        message_path = os.path.join(message_root, entry)
        with open(message_path, "r", encoding="utf-8") as handle:
            message = json.load(handle)
        time_created = message.get("time", {}).get("created", 0)
        message_id = entry.rsplit(".", 1)[0]
        messages_with_time.append((time_created, message_id))

    # Sort messages by timestamp
    messages_with_time.sort()

    tool_calls: list[ToolCall] = []

    for _, message_id in messages_with_time:
        part_root = os.path.join(root, "part", message_id)
        if not os.path.exists(part_root):
            continue

        # Collect parts with timestamps
        parts_with_time: list[tuple[int, str, dict[str, Any]]] = []
        for part_entry in os.listdir(part_root):
            if not part_entry.endswith(".json"):
                continue
            path = os.path.join(part_root, part_entry)
            with open(path, "r", encoding="utf-8") as handle:
                part = json.load(handle)
            if part.get("type") != "tool":
                continue
            time_start = part.get("time", {}).get("start", 0)
            parts_with_time.append((time_start, path, part))

        # Sort parts by timestamp
        parts_with_time.sort()

        for _, _, part in parts_with_time:
            sub_tool = part.get("tool")
            if not sub_tool:
                continue
            sub_state = part.get("state", {})
            sub_params = sub_state.get("input")
            tool_calls.append(ToolCall(sub_tool.lower(), sub_params or {}))

    return tool_calls


def extract_session_id(events: list[dict[str, Any]]) -> str:
    """Extract session ID from events."""
    for event in events:
        if "sessionID" in event:
            return event.get("sessionID", "")
    return ""


def extract_final_answer(events: list[dict[str, Any]]) -> str:
    """Extract final answer text from events (last text message only)."""
    text_events = [
        e for e in events if e.get("type") == "text" or e.get("type") == "message"
    ]

    if not text_events:
        return ""

    last_event = text_events[-1]
    text = last_event.get("text") or last_event.get("content", "")

    if not text:
        part = last_event.get("part", {})
        text = part.get("text", "")

    return text


def extract_token_usage(events: list[dict[str, Any]]) -> TokenUsage:
    """Extract token usage from step_finish events."""
    usage: TokenUsage = {
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cache_write": 0,
    }

    for event in events:
        if event.get("type") == "step_finish":
            part = event.get("part", {})
            tokens = part.get("tokens", {})
            usage["input"] += tokens.get("input", 0)
            usage["output"] += tokens.get("output", 0)
            usage["reasoning"] += tokens.get("reasoning", 0)
            cache = tokens.get("cache", {})
            usage["cache_read"] += cache.get("read", 0)
            usage["cache_write"] += cache.get("write", 0)

    return usage


def extract_cost(events: list[dict[str, Any]]) -> float:
    """Extract total cost from step_finish events."""
    total_cost = 0.0

    for event in events:
        if event.get("type") == "step_finish":
            part = event.get("part", {})
            cost = part.get("cost", 0.0)
            total_cost += cost

    return total_cost


def extract_turns(events: list[dict[str, Any]]) -> int:
    """Extract number of turns from step_finish events across all sessions."""
    # Count step_finish events in main session
    main_turns = sum(1 for event in events if event.get("type") == "step_finish")

    # Count turns in sub-agent sessions
    subagent_turns = 0
    for event in events:
        if event.get("type") == "tool_use":
            part = event.get("part", {})
            tool_name = part.get("tool") or event.get("tool")
            if tool_name == "task":
                state = part.get("state", {})
                metadata = state.get("metadata", {})
                session_id = metadata.get("sessionId", "")
                if session_id:
                    subagent_turns += count_subagent_turns(session_id)

    return main_turns + subagent_turns


def count_subagent_turns(session_id: str) -> int:
    """Count step_finish events in a sub-agent session."""
    if not session_id:
        return 0

    root = os.path.join(
        os.path.expanduser("~"),
        ".local",
        "share",
        "opencode",
        "storage",
    )
    message_root = os.path.join(root, "message", session_id)
    if not os.path.exists(message_root):
        return 0

    turn_count = 0

    for entry in os.listdir(message_root):
        if not entry.startswith("msg_"):
            continue
        if not entry.endswith(".json"):
            continue
        message_id = entry.rsplit(".", 1)[0]
        part_root = os.path.join(root, "part", message_id)
        if not os.path.exists(part_root):
            continue

        for part_entry in os.listdir(part_root):
            if not part_entry.endswith(".json"):
                continue
            path = os.path.join(part_root, part_entry)
            with open(path, "r", encoding="utf-8") as handle:
                part = json.load(handle)
            if part.get("type") == "step":
                # Count completed steps (step parts represent turns)
                turn_count += 1

    return turn_count


def check_subagent_usage(tool_calls: list[ToolCall]) -> bool:
    """Check if any task tool calls were made (indicating sub-agent usage)."""
    return any(tc.tool_name == "task" for tc in tool_calls)


def extract_bash_command(tool_call: ToolCall) -> str | None:
    """Extract the first command word from a bash tool call."""
    if tool_call.tool_name != "bash":
        return None

    command = tool_call.tool_params.get("command", "")
    if not command:
        return None

    # Extract first word (command name) from the command string
    # Strip leading/trailing whitespace and split on whitespace
    words = command.strip().split()
    if not words:
        return None

    return words[0]


def is_tool_allowed(tool_call: ToolCall, allowed_tools: list[str]) -> bool:
    """Check if a tool call is allowed based on allowed_tools list.

    Supports special syntax:
    - 'bash/command' allows bash tool calls where first word is 'command'
    - 'tool_name' allows exact tool name match
    """
    tool_name = tool_call.tool_name

    # Check for exact match
    if tool_name in allowed_tools:
        return True

    # Check for bash/command syntax
    if tool_name == "bash":
        bash_cmd = extract_bash_command(tool_call)
        if bash_cmd:
            # Look for bash/cmd pattern in allowed_tools
            bash_pattern = f"bash/{bash_cmd}"
            if bash_pattern in allowed_tools:
                return True

    return False


def format_summary_table(results: list[tuple[str, CaseResult]]) -> str:
    """Format a summary table of all test case results."""
    if not results:
        return "No results to display."

    # Calculate column widths
    max_case_id_len = max(len(case_id) for case_id, _ in results)
    case_id_width = max(max_case_id_len, len("Case ID"))

    # Header
    lines = []
    header = (
        f"{'Case ID':<{case_id_width}} | "
        f"{'Pass':>6} | "
        f"{'Turns':>6} | "
        f"{'Tools':>7} | "
        f"{'Tokens':>12} | "
        f"{'Cost':>10} | "
        f"{'Sub':>4}"
    )
    lines.append(header)
    lines.append("-" * len(header))

    # Data rows
    total_cases = len(results)
    passed_cases = 0
    total_cost = 0.0
    total_tokens = 0

    for case_id, result in results:
        if result["success"]:
            passed_cases += 1

        tokens = result["tokens"]
        # Correct token accounting:
        # - input, cache_read, cache_write are all input tokens
        # - output, reasoning are output tokens
        case_total_tokens = (
            tokens["input"]
            + tokens["cache_read"]
            + tokens["cache_write"]
            + tokens["output"]
            + tokens["reasoning"]
        )
        total_tokens += case_total_tokens
        total_cost += result["cost"]

        pass_str = "✓" if result["success"] else "✗"
        sub_str = "Y" if result["used_subagents"] else "N"

        row = (
            f"{case_id:<{case_id_width}} | "
            f"{pass_str:>6} | "
            f"{result['turns']:>6} | "
            f"{len(result['tool_calls']):>7} | "
            f"{case_total_tokens:>12,} | "
            f"${result['cost']:>9.4f} | "
            f"{sub_str:>4}"
        )
        lines.append(row)

    # Totals row
    lines.append("-" * len(header))
    pass_rate = f"{passed_cases}/{total_cases}"
    totals = (
        f"{'TOTAL':<{case_id_width}} | "
        f"{pass_rate:>6} | "
        f"{'':>6} | "
        f"{'':>7} | "
        f"{total_tokens:>12,} | "
        f"${total_cost:>9.4f} | "
        f"{'':>4}"
    )
    lines.append(totals)

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Benchmark opencode filesystem tool usage"
    )
    parser.add_argument(
        "--cases", default="benchmarks/cases.json", help="Path to test cases JSON"
    )
    parser.add_argument(
        "--model", default="anthropic/claude-sonnet-4-5-20250929", help="Model to use"
    )
    parser.add_argument(
        "--binary",
        default="./packages/opencode/dist/opencode-linux-x64/bin/opencode",
        help="Path to opencode binary",
    )
    parser.add_argument(
        "--agent",
        default="build",
        help="Agent to use (build, general, explore, etc.)",
    )

    args = parser.parse_args()

    if not os.path.exists(args.cases):
        print(f"Error: Cases file not found at {args.cases}")
        sys.exit(1)

    # Convert binary path to absolute so it works from any directory
    args.binary = os.path.abspath(args.binary)

    if not os.path.exists(args.binary):
        print(f"Error: Binary not found at {args.binary}")
        sys.exit(1)

    cases = load_cases(args.cases)

    # Get opencode version once at start
    opencode_version = get_opencode_version()

    print(f"Running benchmark with model: {args.model}")
    print(f"Agent: {args.agent}")
    print(f"OpenCode version: {opencode_version}")
    print(f"Total cases: {len(cases)}")
    print("=" * 60)

    passed_count = 0
    cache_dir = os.path.abspath(os.path.join("benchmarks", "repositories"))
    work_dir = os.path.abspath(os.path.join("benchmarks", "workspaces"))

    # Collect results for summary table
    results: list[tuple[str, CaseResult]] = []

    for case in cases:
        print(f"\nCase: {case['id']}")
        print(f"Repository: {case['repo']}")
        print(f"Commit: {case['commit']}")
        print(f"Prompt: {case['prompt']}")

        # Setup repository checkout
        repo_path = None
        checkout_path = None

        try:
            repo_path = get_or_clone_repo(case["repo"], cache_dir)
            checkout_path = checkout_commit(repo_path, case["commit"], work_dir)
            print(f"  Working directory: {checkout_path}")
        except (RuntimeError, ValueError) as e:
            print(f"  FAILED to setup repository: {e}")
            continue

        # Prepend current datetime to break token caching between runs
        timestamp_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        prompt_with_timestamp = f"[Current time: {timestamp_str}]\n\n{case['prompt']}"

        run_result = run_opencode(
            prompt_with_timestamp, args.model, args.binary, args.agent, checkout_path
        )

        session_id = extract_session_id(run_result.get("events", []))

        # Extract all metrics early so we can include them in dump
        token_usage = extract_token_usage(run_result.get("events", []))
        total_cost = extract_cost(run_result.get("events", []))
        turns = extract_turns(run_result.get("events", []))
        tool_calls = extract_tool_calls(run_result.get("events", []))
        used_subagents = check_subagent_usage(tool_calls)

        if not run_result["success"] and not run_result["events"]:
            error_msg = run_result.get("error") or run_result.get("stderr", "")
            print(f"  FAILED to run: {error_msg}")

            # Create failed CaseResult
            result: CaseResult = {
                "success": False,
                "tool_calls": tool_calls,
                "stderr": run_result.get("stderr", ""),
                "error": run_result.get("error", ""),
                "final_answer": "",
                "tokens": token_usage,
                "cost": total_cost,
                "turns": turns,
                "used_subagents": used_subagents,
            }

            # Dump output for failed case
            output_path = dump_output(
                case["id"],
                session_id,
                args.model,
                case["prompt"],
                run_result,
                args.agent,
                token_usage,
                total_cost,
                turns,
                used_subagents,
                opencode_version,
                case["repo"],
                case["commit"],
                tool_calls,
                False,  # flag_found = False for failed runs
            )

            print(f"  Output dump: {output_path}")
            print(f"  Success: {result['success']}")

            # Display token information
            tokens = result["tokens"]
            total_input = tokens["input"] + tokens["cache_read"] + tokens["cache_write"]
            total_output = tokens["output"] + tokens["reasoning"]
            total_tokens = total_input + total_output

            input_str = f"{total_input:,}"
            if tokens["cache_read"] > 0:
                input_str += f" ({tokens['cache_read']:,} cached)"

            output_str = f"{total_output:,}"
            if tokens["reasoning"] > 0:
                output_str += f" ({tokens['reasoning']:,} reasoning)"

            print(f"  Tokens: {total_tokens:,}")
            print(f"    Input: {input_str}")
            print(f"    Output: {output_str}")
            print(f"  Cost: ${result['cost']:.4f}")

            if result["stderr"]:
                stderr_display = (
                    result["stderr"][:100] + "..."
                    if len(result["stderr"]) > 100
                    else result["stderr"]
                )
                print(f"  Stderr: {stderr_display}")

            if result["error"]:
                print(f"  Error: {result['error']}")

            print(
                f"  Final answer: {result['final_answer'][:100]}..."
                if len(result["final_answer"]) > 100
                else f"  Final answer: {result['final_answer']}"
            )
            print("  Result: FAIL")
            print("-" * 60)

            # Add to results for summary table
            results.append((case["id"], result))

            continue

        final_answer = extract_final_answer(run_result["events"])

        allowed_tools = case.get("allowed_tools", [])

        # Check if only allowed tools were used
        only_allowed_used = all(is_tool_allowed(tc, allowed_tools) for tc in tool_calls)

        # Check if the flag appears in the final answer
        flag = case.get("flag", "")
        flag_found = flag in final_answer if flag else True

        # Dump output for successful case (after we know flag_found)
        output_path = dump_output(
            case["id"],
            session_id,
            args.model,
            case["prompt"],
            run_result,
            args.agent,
            token_usage,
            total_cost,
            turns,
            used_subagents,
            opencode_version,
            case["repo"],
            case["commit"],
            tool_calls,
            flag_found,
        )

        print(f"  Output dump: {output_path}")

        # Determine strict pass/fail:
        # Pass if:
        # 1. Only allowed tools are used (no unexpected tools).
        # 2. Flag appears in final answer (if specified).

        is_pass = only_allowed_used and flag_found

        if is_pass:
            passed_count += 1

        # Create CaseResult
        result: CaseResult = {
            "success": is_pass,
            "tool_calls": tool_calls,
            "stderr": run_result.get("stderr", ""),
            "error": run_result.get("error", ""),
            "final_answer": final_answer,
            "tokens": token_usage,
            "cost": total_cost,
            "turns": turns,
            "used_subagents": used_subagents,
        }

        # Calculate unexpected tools (those that don't match any allowed pattern)
        unexpected_tools = [
            str(tc) for tc in tool_calls if not is_tool_allowed(tc, allowed_tools)
        ]

        # Display CaseResult fields
        print(f"  Session ID: {session_id}")
        print(f"  Success: {result['success']}")
        print(f"  Tool calls: {[str(tc) for tc in tool_calls]}")
        print(f"  Turns: {result['turns']}")
        print(f"  Used sub-agents: {result['used_subagents']}")
        tokens = result["tokens"]
        # Correct token accounting:
        # - input + cache_read + cache_write = total input tokens
        # - output + reasoning = total output tokens
        total_input = tokens["input"] + tokens["cache_read"] + tokens["cache_write"]
        total_output = tokens["output"] + tokens["reasoning"]
        total_tokens = total_input + total_output

        # Format token display
        input_str = f"{total_input:,}"
        if tokens["cache_read"] > 0:
            input_str += f" ({tokens['cache_read']:,} cached)"

        output_str = f"{total_output:,}"
        if tokens["reasoning"] > 0:
            output_str += f" ({tokens['reasoning']:,} reasoning)"

        print(f"  Tokens: {total_tokens:,}")
        print(f"    Input: {input_str}")
        print(f"    Output: {output_str}")
        print(f"  Cost: ${result['cost']:.4f}")

        # Only print stderr if non-empty
        if result["stderr"]:
            stderr_display = (
                result["stderr"][:100] + "..."
                if len(result["stderr"]) > 100
                else result["stderr"]
            )
            print(f"  Stderr: {stderr_display}")

        # Only print error if non-empty
        if result["error"]:
            print(f"  Error: {result['error']}")

        print(
            f"  Final answer: {result['final_answer'][:100]}..."
            if len(result["final_answer"]) > 100
            else f"  Final answer: {result['final_answer']}"
        )

        # Only print unexpected tools if non-empty
        if unexpected_tools:
            print(f"  Unexpected tools: {unexpected_tools}")

        print(f"  Flag found: {flag_found}")
        print(f"  Result: {'PASS' if is_pass else 'FAIL'}")
        print("-" * 60)

        # Add to results for summary table
        results.append((case["id"], result))

        # Cleanup worktree if used
        if repo_path and checkout_path:
            cleanup_worktree(repo_path, checkout_path)

    # Summary
    total = len(cases)
    print(f"\nSummary: {passed_count}/{total} passed")
    print()
    print(format_summary_table(results))


if __name__ == "__main__":
    main()
