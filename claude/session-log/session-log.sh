#!/bin/bash
#
# SessionEnd hook: spawns a detached claude process to summarize the session
# and append to ~/.claude/SESSION_LOG.md
#
# Dedup strategy: each entry records the JSONL line count in an HTML comment.
# On resumed sessions, we tail past already-processed lines before summarizing.
#

LOG_FILE="$HOME/.claude/SESSION_LOG.md"
TRACE_LOG="$HOME/.claude/SESSION_END_TRACE.log"
TODAY=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%H:%M:%S)

log() { echo "$(date -Iseconds) $*" >> "$TRACE_LOG"; }

log "hook fired"

# Guard against cascade: the detached claude -p process we spawn is itself a
# Claude Code session. When it exits, it fires SessionEnd again. Break the loop.
if [[ -n "$CLAUDE_SESSION_LOG_ACTIVE" ]]; then
    log "skipping (spawned by session-log hook)"
    exit 0
fi

# Read hook input from stdin
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
    log "no transcript found: $TRANSCRIPT_PATH"
    exit 0
fi

# Check for previous entry for this session (resumed session dedup)
PREV_LINES=0
if [[ -f "$LOG_FILE" && -n "$SESSION_ID" ]]; then
    PREV_LINES=$(grep "<!-- ${SESSION_ID}:" "$LOG_FILE" | tail -1 | sed 's/.*<!-- '"$SESSION_ID"':\([0-9]*\) -->.*/\1/')
    PREV_LINES=${PREV_LINES:-0}
fi

TOTAL_LINES=$(wc -l < "$TRANSCRIPT_PATH")

if [[ "$TOTAL_LINES" -le "$PREV_LINES" ]]; then
    log "no new lines in transcript ($TOTAL_LINES <= $PREV_LINES), skipping"
    exit 0
fi

log "transcript: $TRANSCRIPT_PATH (lines: $PREV_LINES+1 to $TOTAL_LINES)"

# Extract only new lines to a temp file
WORK_FILE="/tmp/claude-session-${RANDOM}-${SESSION_ID}"
if [[ "$PREV_LINES" -gt 0 ]]; then
    tail -n "+$((PREV_LINES + 1))" "$TRANSCRIPT_PATH" > "$WORK_FILE"
else
    cp "$TRANSCRIPT_PATH" "$WORK_FILE"
fi

# Compact via claude-stream if available
if command -v claude-stream &>/dev/null; then
    if claude-stream --compact --format markdown "$WORK_FILE" > "${WORK_FILE}.md" 2>/dev/null; then
        mv "${WORK_FILE}.md" "$WORK_FILE"
        log "compacted via claude-stream"
    else
        rm -f "${WORK_FILE}.md"
        log "claude-stream failed, using raw JSONL"
    fi
else
    log "claude-stream not found, using raw JSONL"
fi

# Spawn a detached process to summarize and append to the log
nohup bash -c '
SUMMARY=$({
    echo "<transcript>"
    cat "$1"
    echo "</transcript>"
    cat <<RULES
Rules:
- One bullet per accomplishment, terse -- action and outcome, not process
- If the session was trivial (just greetings, testing, etc.), a single bullet is fine
- If any decisions were made with stated rationale, use this pattern:
  - decision: short description of the decision
    - rationale: verbatim quote from the user, e.g. user said, "the exact words they used"
  Only include rationale that was explicitly stated -- never infer or paraphrase
- Do NOT include any headers, paragraphs, or any other elements -- ONLY a bulleted list

Example of correct output:
- Fixed authentication bug in login flow
- Refactored database connection pooling
- decision: use Redis for session storage
  - rationale: user said, "we need sub-millisecond lookups"
RULES
} | ANTHROPIC_API_KEY="" CLAUDE_SESSION_LOG_ACTIVE=1 claude -p --model haiku --system-prompt "You are a session log writer. The session transcript is provided on stdin. Output ONLY markdown bullet lines starting with \"- \". No headings, no preamble, no labels, no bold text, no explanation -- just the bullets.")

if [[ -n "$SUMMARY" ]]; then
    LAST_HEADING=$(grep "^## " "$2" 2>/dev/null | tail -1)
    {
        if [[ "$LAST_HEADING" != "## $3" ]]; then
            [[ -s "$2" ]] && echo ""
            echo "## $3"
        fi
        echo ""
        echo "### $4 @ $5"
        echo "<!-- $4:$6 -->"
        echo ""
        echo "$SUMMARY"
    } >> "$2"
    echo "$(date -Iseconds) wrote summary to log" >> "$7"
else
    echo "$(date -Iseconds) no summary generated" >> "$7"
fi

rm -f "$1"
' -- "$WORK_FILE" "$LOG_FILE" "$TODAY" "$SESSION_ID" "$TIMESTAMP" "$TOTAL_LINES" "$TRACE_LOG" >>"$TRACE_LOG" 2>&1 &

log "detached claude process spawned (pid $!)"
exit 0
