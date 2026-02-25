#!/usr/bin/env bash
#
# Add the no-verify git wrapper to Claude Code's environment.
#
# Updates ~/.claude/settings.json to prepend the wrapper directory to PATH
# so that Claude's `git` resolves to the wrapper before the real binary.
#
# Usage:
#   bash setup-claude-env.sh [--mode strict|warn] [--remove]
#
# Options:
#   --mode MODE   Also set GIT_NOVERIFY_MODE in Claude's env (default: strict)
#   --remove      Remove the wrapper from Claude's env

set -euo pipefail

SETTINGS_FILE="$HOME/.claude/settings.json"
WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
    echo "Usage: $(basename "$0") [--mode strict|warn] [--remove]"
    echo ""
    echo "Options:"
    echo "  --mode MODE   Set GIT_NOVERIFY_MODE in Claude's env (default: strict)"
    echo "  --remove      Remove the wrapper from Claude's env"
}

# Parse args
MODE="strict"
REMOVE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            MODE="$2"
            if [[ "$MODE" != "strict" && "$MODE" != "warn" ]]; then
                echo "error: mode must be 'strict' or 'warn'" >&2
                exit 1
            fi
            shift 2
            ;;
        --remove)
            REMOVE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo "error: $SETTINGS_FILE not found" >&2
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "error: jq is required" >&2
    exit 1
fi

if [[ "$REMOVE" == true ]]; then
    # Remove wrapper dir from PATH and GIT_NOVERIFY_MODE from env
    jq --arg dir "$WRAPPER_DIR" '
        # Remove GIT_NOVERIFY_MODE
        if .env.GIT_NOVERIFY_MODE then .env |= del(.GIT_NOVERIFY_MODE) else . end
        # Remove wrapper dir from PATH
        | if .env.PATH then
            .env.PATH |= (split(":") | map(select(. != $dir)) | join(":"))
            | if .env.PATH == "" then .env |= del(.PATH) else . end
          else . end
        # Clean up empty env object
        | if .env == {} then del(.env) else . end
    ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" \
        && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
    echo "Removed no-verify wrapper from Claude env"
else
    # Add wrapper dir to PATH and set GIT_NOVERIFY_MODE
    jq --arg dir "$WRAPPER_DIR" --arg mode "$MODE" '
        .env //= {}
        # Prepend wrapper dir to PATH if not already present
        | if .env.PATH then
            if (.env.PATH | split(":") | index($dir)) then .
            else .env.PATH = ($dir + ":" + .env.PATH)
            end
          else
            .env.PATH = ($dir + ":${PATH}")
          end
        | .env.GIT_NOVERIFY_MODE = $mode
    ' "$SETTINGS_FILE" > "${SETTINGS_FILE}.tmp" \
        && mv "${SETTINGS_FILE}.tmp" "$SETTINGS_FILE"
    echo "Added no-verify wrapper to Claude env:"
    echo "  PATH: $WRAPPER_DIR prepended"
    echo "  GIT_NOVERIFY_MODE: $MODE"
fi
