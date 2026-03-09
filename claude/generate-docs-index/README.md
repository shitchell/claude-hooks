# generate-docs-index

A Claude Code `SessionStart` hook that scans a docs directory for markdown
files with YAML frontmatter and generates a grouped documentation index.
Gives Claude immediate awareness of all project documentation and when to
read each document.

## What it does

1. Finds all `.md` files in the configured docs directory
2. Parses YAML frontmatter (`title`, `description`, `when`, `tags`)
3. Groups files by subdirectory and renders a markdown table per group
4. Outputs the index to stdout (loaded into Claude's session context)
5. Optionally persists to a file via `tee` (Claude still sees the full index)

### Expected frontmatter

```yaml
---
title: Architecture
description: Comprehensive architecture reference for the framework.
when: Understanding the framework architecture, making structural changes
tags: [architecture, specs, framework]
---
```

Files without frontmatter (or without at least a `title`) are silently skipped.

### Example output

```markdown
# Documentation Index

## guides

| Document | Description | Read when... | Tags |
|----------|-------------|--------------|------|
| [Testing](guides/testing.md) | How to write and run tests. | Writing tests, debugging failures | testing, guides |

## specs

| Document | Description | Read when... | Tags |
|----------|-------------|--------------|------|
| [Architecture](specs/architecture.md) | Framework architecture reference. | Understanding the architecture | architecture, specs |
```

## Installation

1. Copy or link the script into your hooks directory:

   ```bash
   cp generate-docs-index.sh ~/.claude/hooks/scripts/
   # or
   ln ~/.claude/hooks/scripts/generate-docs-index.sh generate-docs-index/generate-docs-index.sh
   ```

2. Register it in `~/.claude/settings.json` (or a project `.claude/settings.json`):

   ```json
   {
     "hooks": {
       "SessionStart": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "bash .claude/hooks/scripts/generate-docs-index.sh"
             }
           ]
         }
       ]
     }
   }
   ```

## Configuration

The hook sources `.claude/generate-docs-index.conf` files walk-forward from
`~` to `$PWD`. Each level can override previous settings, so you can set
global defaults in `~/.claude/generate-docs-index.conf` and per-project
overrides in `<project>/.claude/generate-docs-index.conf`.

See [generate-docs-index.sample.conf](generate-docs-index.sample.conf) for
all available options.

### Quick examples

Scan a different directory:

```bash
# .claude/generate-docs-index.conf
DOCS_DIR=documentation
```

Persist the index to a file (Claude still sees it in session context via tee):

```bash
# .claude/generate-docs-index.conf
OUTPUT_FILE=docs/INDEX.md
```
