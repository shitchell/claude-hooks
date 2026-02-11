# session-log

A Claude Code `SessionEnd` hook that automatically summarizes each session and
appends the summary to `~/.claude/SESSION_LOG.md`. Gives you a persistent,
browsable log of what you accomplished across sessions.

## How It Works

1. When a session ends, Claude Code passes the transcript path via stdin
2. The hook extracts new lines since the last log entry (handles resumed sessions)
3. Optionally compacts the transcript via `claude-stream` for smaller input
4. Spawns a **detached** `claude -p --model haiku` process to summarize
5. Appends terse bullet-point summaries to the log, grouped by date

## Output Format

```markdown
## 2026-02-10

### abc12345-session-id @ 14:30:00
<!-- abc12345-session-id:1523 -->

- Built project-overview hook with config walk-forward
- Created claude-hooks repo with hardlinked scripts
- decision: use hardlinks instead of symlinks for repo copies
  - rationale: user said, "we can keep all hook scripts hardlinked"
```

## Features

- **Resumed session dedup**: Tracks JSONL line counts in HTML comments to avoid
  re-summarizing already-logged portions of resumed sessions
- **Cascade guard**: Sets `CLAUDE_SESSION_LOG_ACTIVE` env var to prevent the
  spawned claude process from triggering the hook again on its own exit
- **Non-blocking**: Spawns summary generation in background via `nohup` so the
  session exits immediately
- **Rationale capture**: Extracts decisions with verbatim user quotes when stated

## Prerequisites

- `jq` — for parsing hook input JSON
- `claude` CLI — for generating summaries (uses `--model haiku`)
- `claude-stream` (optional) — compacts transcripts before summarizing

## Installation

1. Copy `session-log.sh` to `~/.claude/hooks/`
2. Make it executable: `chmod +x ~/.claude/hooks/session-log.sh`
3. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/hooks/session-log.sh"
          }
        ]
      }
    ]
  }
}
```

## Debugging

A trace log is written to `~/.claude/SESSION_END_TRACE.log` with timestamps
for each step. A companion `session-end-debug.sh` script is also available
that simply dumps the raw hook input JSON to `~/.claude/SESSION_END_DEBUG.json`
for inspection.

## Files

- `session-log.sh` — Main hook script
- `session-end-debug.sh` — Debug helper that captures raw hook input
