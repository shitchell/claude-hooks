#!/bin/bash
# Debug: log that we ran at all
echo "$(date -Iseconds) hook fired" >> /home/guy/.claude/SESSION_END_TRACE.log

# Capture stdin
INPUT=$(cat)
echo "$INPUT" > /home/guy/.claude/SESSION_END_DEBUG.json

# Log success
echo "$(date -Iseconds) wrote debug json" >> /home/guy/.claude/SESSION_END_TRACE.log
