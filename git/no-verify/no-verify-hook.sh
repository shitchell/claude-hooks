#!/usr/bin/env bash
#
# Claude Code PreToolUse hook: intercept --no-verify in git commands.
#
# Parses the Bash tool input for git commands containing --no-verify,
# stopping argument scanning at --. Returns a block/warn/allow decision.
#
# Configuration (checked in order):
#   1. Environment variable: GIT_NOVERIFY_MODE
#   2. Git config: noverify.mode
#
# Modes:
#   strict  - Block the command (return {"decision": "block"})
#   warn    - Allow with a warning message
#   (unset) - Allow silently (hook is a no-op)
#
# Log file (checked in order):
#   1. Environment variable: GIT_NOVERIFY_LOG
#   2. Git config: noverify.log
#   3. Default: ~/.cache/git-noverify/noverify.log
#
#   Set to "" or "none" to disable logging.
#
# Hook setup in ~/.claude/settings.json:
#   {
#     "hooks": {
#       "PreToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "bash /path/to/no-verify-hook.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the command string from the Bash tool input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ -z "$COMMAND" ]]; then
    exit 0
fi

# Tokenize the command and check if it's a git invocation with --no-verify.
# This is a simplified parse — it handles the common cases:
#   git commit --no-verify
#   git push --no-verify -m "msg"
#   git -C /path commit --no-verify
# It does NOT handle:
#   eval "git commit --no-verify"
#   cmd="git commit --no-verify"; $cmd
#   git commit --no-verify && git push  (scans whole line, may false-positive on chained cmds)

# Check if the command involves git at all (quick bail-out)
if ! echo "$COMMAND" | grep -qw 'git'; then
    exit 0
fi

# Extract words, respecting that this is a rough tokenization
# We scan for: git [global-opts] subcommand [args...] looking for --no-verify before --
found_noverify=false

# Use a simple word-level scan of the command string
# This won't perfectly handle all quoting, but covers the vast majority of cases
while IFS= read -r -d '' word || [[ -n "$word" ]]; do
    [[ "$word" == "--" ]] && break
    if [[ "$word" == "--no-verify" || "$word" == "-n" ]]; then
        found_noverify=true
        break
    fi
done < <(printf '%s' "$COMMAND" | tr -s '[:space:]' '\0')

if [[ "$found_noverify" != true ]]; then
    exit 0
fi

# Determine mode
MODE="${GIT_NOVERIFY_MODE:-}"
if [[ -z "$MODE" ]]; then
    MODE=$(git config --get noverify.mode 2>/dev/null || true)
fi

# No mode configured — allow silently
if [[ -z "$MODE" ]]; then
    exit 0
fi

# Determine log file
LOG_FILE="${GIT_NOVERIFY_LOG:-}"
if [[ -z "$LOG_FILE" ]]; then
    LOG_FILE=$(git config --get noverify.log 2>/dev/null || true)
fi
if [[ -z "$LOG_FILE" ]]; then
    LOG_FILE="$HOME/.cache/git-noverify/noverify.log"
fi

# Log the --no-verify usage
log_event() {
    local action="$1"

    # Disable logging if set to "none"
    if [[ "$LOG_FILE" == "none" ]]; then
        return
    fi

    local log_dir
    log_dir="$(dirname "$LOG_FILE")"
    if [[ ! -d "$log_dir" ]]; then
        mkdir -p "$log_dir"
        chmod 700 "$log_dir"
    fi

    {
        date -Iseconds
        echo "Action: $action"
        echo "Mode: $MODE"
        echo "User: ${USER:-unknown}"
        echo "PWD: ${PWD:-unknown}"
        echo "Command: $COMMAND"
        echo "---"
    } >> "$LOG_FILE"
    chmod 600 "$LOG_FILE" 2>/dev/null
}

if [[ "$MODE" == "strict" ]]; then
    REASON="--no-verify is disabled. If you take issue with a git hook, escalate to a human rather than bypassing it."
    log_event "BLOCKED"
    echo '{"decision":"block","reason":"'"$(echo "$REASON" | sed 's/"/\\"/g')"'"}'
elif [[ "$MODE" == "warn" ]]; then
    REASON="Warning: --no-verify bypasses commit hooks. You should report this action for review and discussion why the hook warranted bypassing."
    log_event "WARNING"
    echo '{"decision":"allow","reason":"'"$(echo "$REASON" | sed 's/"/\\"/g')"'"}'
fi
