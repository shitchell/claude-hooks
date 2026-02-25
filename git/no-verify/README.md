# No-Verify Guard

Intercept `--no-verify` usage in git commands. Two approaches:

## Option A: PreToolUse Hook (recommended for Claude Code)

Intercepts the Bash tool before commands run. No PATH manipulation needed.

### Setup

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/no-verify-hook.sh"
          }
        ]
      }
    ]
  }
}
```

### Behavior

| Mode | `--no-verify` detected | Result |
|------|----------------------|--------|
| `strict` | Yes | Command blocked, error shown |
| `warn` | Yes | Warning shown, command proceeds |
| (unset) | Yes | Silent pass-through |

## Option B: Git Wrapper (works outside Claude Code)

A `git` wrapper placed earlier in PATH than the real binary. Same behavior
as the hook but works in any shell environment.

### Setup

```bash
# Automated: updates ~/.claude/settings.json to prepend wrapper to PATH
bash setup-claude-env.sh --mode strict

# Manual: add to PATH yourself
export PATH="/path/to/no-verify:$PATH"

# Remove
bash setup-claude-env.sh --remove
```

## Configuration

Mode is checked in order:

1. **Environment variable**: `GIT_NOVERIFY_MODE=strict|warn`
2. **Git config**: `git config noverify.mode strict`

If neither is set, the guard is effectively disabled (silent pass-through).

### Logging

Every block/warn event is logged. Log file is checked in order:

1. **Environment variable**: `GIT_NOVERIFY_LOG=/path/to/file.log`
2. **Git config**: `git config noverify.log /path/to/file.log`
3. **Default**: `~/.cache/git-noverify/noverify.log`

Set to `none` to disable logging entirely:

```bash
export GIT_NOVERIFY_LOG=none
```

Each log entry records:

```
2026-02-25T14:30:00-05:00
Action: BLOCKED
Mode: strict
User: guy
PWD: /home/guy/project
Command: git commit --no-verify -m "skip hooks"
---
```

### Modes

**strict** — Block the command entirely:

```
 ┌─────────────────────────────────────────────────────────────────┐
 │  --no-verify is disabled                                        │
 └─────────────────────────────────────────────────────────────────┘

 If you take issue with a git hook, escalate to a human rather
 than bypassing it.
```

**warn** — Print a warning but allow the command:

```
Warning: you have bypassed commit hooks. You should report this
action for review and discussion why the hook warranted bypassing.
Otherwise, you should consider resetting your commit and retrying in
accordance with the established procedures of this repository.
```

## How it works

Both approaches scan arguments left-to-right, stopping at `--`:

```
git commit --no-verify -m "msg"     → detected (before --)
git commit -m "msg" --no-verify     → detected (before --)
git commit -m "--no-verify"         → false positive (limitation)
git commit -- --no-verify           → not detected (after --)
```

The `-n` short flag (alias for `--no-verify` in `git commit`) is also caught.

## Files

| File | Purpose |
|------|---------|
| `git` | PATH-based wrapper (Option B) |
| `no-verify-hook.sh` | PreToolUse hook (Option A) |
| `setup-claude-env.sh` | Automated setup for Option B |
