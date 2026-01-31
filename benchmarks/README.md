# OpenCode Benchmarks

This directory contains benchmarks for evaluating LLM performance on filesystem tool usage in OpenCode.

## Overview

The benchmark evaluates how well different LLMs use specialized filesystem tools (Read, Glob, Grep) instead of falling back to bash commands when working with code repositories. This is critical for ensuring agents use the most appropriate and efficient tools available.

## Quick Start

### Prerequisites

1. Build OpenCode:

   ```bash
   ./packages/opencode/script/build.ts --single
   ```

2. Ensure Python 3.x is installed

### Running the Benchmark

Run the benchmark for a single model:

```bash
PYTHONUNBUFFERED=1 python benchmarks/bench.py --model <model-name> --agent build
```

### Standard Models

We regularly benchmark these 4 models:

1. **anthropic/claude-opus-4-5-20251101** - Highest reliability, best tool discipline
2. **anthropic/claude-sonnet-4-5-20250929** - Best value, good performance
3. **openai/gpt-5.2-codex** - Good tool discipline, extreme token usage
4. **google/gemini-3-pro-preview** - Testing alternative providers

### Running All Benchmarks

```bash
# Run all 4 standard models
PYTHONUNBUFFERED=1 python benchmarks/bench.py --model anthropic/claude-opus-4-5-20251101 --agent build
PYTHONUNBUFFERED=1 python benchmarks/bench.py --model anthropic/claude-sonnet-4-5-20250929 --agent build
PYTHONUNBUFFERED=1 python benchmarks/bench.py --model openai/gpt-5.2-codex --agent build
PYTHONUNBUFFERED=1 python benchmarks/bench.py --model google/gemini-3-pro-preview --agent build
```

## Command Line Options

```
--cases       Path to test cases JSON (default: benchmarks/cases.json)
--model       Model identifier (default: anthropic/claude-sonnet-4-5-20250929)
--binary      Path to opencode binary (default: ./packages/opencode/dist/opencode-linux-x64/bin/opencode)
--agent       Agent to use: build, general, explore (default: build)
```

## Test Cases

The benchmark includes 5 test cases:

1. **where-is-anthropic-system-prompt** - Find system prompt file for Anthropic
2. **where-is-bash-txt** - Find bash tool instruction file
3. **where-is-oauth-callback** - Find OAuth callback implementation
4. **lib-for-md-in-desktop** - Identify markdown parsing library
5. **dd-trace-java-look-for-test** - Find complex test file in external repo

Test cases are defined in `benchmarks/cases.json`.

## Output

### Console Output

The benchmark displays real-time progress including:

- Per-case results (pass/fail)
- Tool calls made
- Token usage and cost
- Number of turns
- Summary table at the end

### JSON Output

Detailed results are saved to `benchmarks/output/<case-id>/<timestamp>-<session-id>.json` containing:

- Complete event stream
- Tool calls with parameters
- Token usage breakdown
- Cost information
- OpenCode version
- Repository and commit information

### Analysis Report

Comparative analysis of all models is documented in `benchmarks/ANALYSIS.md`.

## Scoring

Tests pass when:

1. Only allowed tools are used (no inappropriate bash commands)
2. The expected flag/answer appears in the final response

Tests fail when:

- Inappropriate bash commands are used (e.g., `find`, `grep -A`, `ls`)
- The expected answer is not found in the response
- No tools are used (hallucination)

## Cache Breaking

The benchmark automatically prepends a timestamp to each prompt to prevent token cache contamination between runs:

```
[Current time: YYYY-MM-DD HH:MM:SS UTC]
<original prompt>
```

## Repository Management

The benchmark uses git worktrees for efficient repository management:

- Clones are cached in `benchmarks/repositories/`
- Working copies are created in `benchmarks/workspaces/`
- Each test case runs in an isolated checkout at a specific commit

## Troubleshooting

### Binary not found

```bash
# Rebuild OpenCode
./packages/opencode/script/build.ts --single
```

### Permission errors

```bash
# Ensure binary is executable
chmod +x ./packages/opencode/dist/opencode-linux-x64/bin/opencode
```

### Python buffering issues

Always use `PYTHONUNBUFFERED=1` to see real-time output.

## Development

### Adding New Test Cases

Edit `benchmarks/cases.json`:

```json
{
  "id": "test-case-id",
  "repo": "github.com/org/repo",
  "commit": "commit-sha",
  "prompt": "Your test prompt",
  "allowed_tools": ["read", "glob", "grep", "bash/ls"],
  "flag": "expected-string-in-answer"
}
```

### Allowed Tools Syntax

- `"read"`, `"glob"`, `"grep"` - Allow these tools
- `"bash/ls"`, `"bash/git"` - Allow specific bash commands
- Bash commands are validated by first word only

### Re-running Analysis

After running benchmarks, you can generate a new analysis by examining the JSON output files in `benchmarks/output/` and updating `benchmarks/ANALYSIS.md`.

## Performance Notes

- **PYTHONUNBUFFERED=1** is required for real-time output
- Average runtime: 2-5 minutes per model (5 test cases)
- Token caching significantly reduces cost on subsequent runs
- Gemini models take longer due to reasoning overhead

## Latest Results (2026-01-25)

| Model                | Pass Rate | Avg Cost | Avg Tokens |
| -------------------- | --------- | -------- | ---------- |
| Claude Opus          | 80% (4/5) | $0.0817  | 336.6      |
| Claude Sonnet        | 80% (4/5) | $0.0523  | 506.4      |
| GPT-5.2-codex        | 80% (4/5) | $0.0000  | 20,262.2   |
| Gemini 3 Pro Preview | 40% (2/5) | $0.1064  | 33,717.6   |

See `benchmarks/ANALYSIS.md` for detailed analysis.
