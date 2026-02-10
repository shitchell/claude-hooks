# project-overview

A Claude Code `SessionStart` hook that prints a markdown overview of the
current project directory. Gives Claude immediate context about the project
structure, notable files, and key documentation.

## What it does

1. **Structure** -- runs `find` and pipes through `tree --fromfile` (falls back
   to flat listing if `tree` doesn't support `--fromfile`)
2. **Notable files** -- highlights common documentation and config files at the
   project root (`README*`, `Makefile`, `pyproject.toml`, etc.) and doc
   directories (`docs/`, `.github/`)
3. **Cat sections** -- prints the contents of files matching configurable
   patterns (default: `INDEX.md`)

### Example output

```markdown
# Project Overview: myapp

## Structure

` `` (triple backticks in actual output)
.
├── README.md
├── Makefile
├── src
│   ├── main.py
│   └── utils.py
├── docs
│   └── INDEX.md
└── tests
    └── test_main.py

3 directories, 6 files
` ``

## Notable Files

- README.md
- Makefile
- docs/

## INDEX.md (docs/INDEX.md)

- main.py: Application entry point
- utils.py: Shared utilities
```

## Installation

1. Copy or link the script into your hooks directory:

   ```bash
   cp project-overview.sh ~/.claude/hooks/
   # or
   ln ~/.claude/hooks/project-overview.sh project-overview/project-overview.sh
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
               "command": "bash ~/.claude/hooks/project-overview.sh"
             }
           ]
         }
       ]
     }
   }
   ```

## Configuration

The hook sources `.claude/project-overview.conf` files walk-forward from `~` to
`$PWD`. Each level can override or extend previous settings, so you can set
global defaults in `~/.claude/project-overview.conf` and per-project overrides
in `<project>/.claude/project-overview.conf`.

See [project-overview.sample.conf](project-overview.sample.conf) for all
available options.

### Pattern syntax

All file/directory patterns use `find`'s `-name` glob syntax by default.
Patterns containing `/` switch to `-path` matching:

| Pattern | Behavior |
|---------|----------|
| `foo.txt` | `-name 'foo.txt'` -- matches anywhere by basename |
| `docs/foo.txt` | `-path '*/docs/foo.txt'` -- matches the relative structure |
| `/docs/foo.txt` | `-path '$PWD/docs/foo.txt'` -- matches from project root |

### Config precedence example

```
~/.claude/project-overview.conf              # global defaults
~/code/.claude/project-overview.conf         # all code projects
~/code/myapp/.claude/project-overview.conf   # project-specific
```

Each file is sourced in order. Later values overwrite earlier ones.
