# generate-tool-docs

A Claude Code `SessionStart` hook that generates `~/.claude/TOOLS.md` with
`--help` output from configured CLI tools. Keeps Claude's context up-to-date
with the latest documentation for your local tools.

## What it does

Iterates over a list of CLI tool names, runs `--help` (falling back to `-h`,
then `help`) on each, and writes the output to `~/.claude/TOOLS.md` as
markdown. Tools not found in `$PATH` are noted as missing.

The generated file is loaded into Claude's system prompt, giving it instant
awareness of your local tooling.

## Installation

1. Copy or link the script into your hooks directory:

   ```bash
   cp generate-tool-docs.sh ~/.claude/hooks/
   # or
   ln ~/.claude/hooks/generate-tool-docs.sh generate-tool-docs/generate-tool-docs.sh
   ```

2. Register it in `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "bash ~/.claude/hooks/generate-tool-docs.sh"
             }
           ]
         }
       ]
     }
   }
   ```

## Configuration

Create `~/.claude-tools.conf` to customize the tool list.

See [claude-tools.sample.conf](claude-tools.sample.conf) for all available
options.

### Quick examples

Add a tool to the defaults:

```bash
# ~/.claude-tools.conf
TOOLS_EXTRA=(kubectl helm)
```

Replace the tool list entirely:

```bash
# ~/.claude-tools.conf
TOOLS=(docker kubectl helm terraform)
```
