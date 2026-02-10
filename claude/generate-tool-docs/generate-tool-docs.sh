#!/usr/bin/env bash
#
# generate-tool-docs.sh - Generate TOOLS.md from CLI tool --help output
#
# Generates ~/.claude/TOOLS.md with help text from configured CLI tools.
# This keeps Claude's context up-to-date with the latest tool documentation.
#
# Configuration: ~/.claude-tools.conf
#   TOOLS=(...)        - Replace the default tool list
#   TOOLS_EXTRA=(...)  - Append to the default tool list
#
# Usage:
#   Called by Claude Code SessionStart hook, or manually:
#   ~/.claude/hooks/generate-tool-docs.sh

set -euo pipefail

# Default tools to document
DEFAULT_TOOLS=(
    claude-pane
    jira
    cdp
    atspi
    o365
    capture-command
)

# Config and output paths
CONFIG_FILE="${HOME}/.claude-tools.conf"
OUTPUT_FILE="${HOME}/.claude/TOOLS.md"

# Load configuration
TOOLS=()
TOOLS_EXTRA=()

if [[ -f "${CONFIG_FILE}" ]]; then
    # shellcheck source=/dev/null
    source "${CONFIG_FILE}"
fi

# Build final tool list
if [[ ${#TOOLS[@]} -eq 0 ]]; then
    # No override - use defaults + extras
    TOOLS=("${DEFAULT_TOOLS[@]}" "${TOOLS_EXTRA[@]}")
fi

# Generate the markdown file
{
    echo "# CLI Tool Reference"
    echo ""
    echo "Auto-generated documentation for local CLI tools."
    echo "Last updated: $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""

    for tool in "${TOOLS[@]}"; do
        # Skip if tool doesn't exist
        if ! command -v "${tool}" &>/dev/null; then
            echo "## ${tool}"
            echo ""
            echo "*Tool not found in PATH*"
            echo ""
            continue
        fi

        echo "## ${tool}"
        echo ""
        echo '```'
        # Try --help first, fall back to -h, then help subcommand
        if "${tool}" --help 2>&1; then
            :
        elif "${tool}" -h 2>&1; then
            :
        elif "${tool}" help 2>&1; then
            :
        else
            echo "(no help available)"
        fi
        echo '```'
        echo ""
    done
} > "${OUTPUT_FILE}"

# Output for Claude's context (shown in session)
echo "Generated ${OUTPUT_FILE} with documentation for ${#TOOLS[@]} tools"
