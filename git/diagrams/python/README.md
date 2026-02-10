# Python Diagram Generation Hooks

> **EXPERIMENTAL**: This hook has not been tested against real projects. The
> approach mirrors the [Go version](../golang/) but uses Python-specific
> tooling. Please report issues and suggest improvements.

Automatically generate and maintain class diagrams and package dependency
diagrams from Python source code using `pyreverse` (part of pylint).

## What it generates

- **Class diagram** (`classes.dot` / `classes.svg`) -- UML class diagram
  showing classes, attributes, methods, and inheritance via
  [pyreverse](https://pylint.readthedocs.io/en/latest/pyreverse.html)
- **Package diagram** (`packages.dot` / `packages.svg`) -- module/package
  dependency graph showing import relationships

## How it works

1. **Pre-commit hook** detects staged `.py` files
2. Calls **generate-diagrams.sh** which:
   - Runs `pyreverse -o dot` to produce `.dot` source files
   - Compares against existing sources (pyreverse output is deterministic,
     so simple diff is sufficient)
   - Renders SVGs via graphviz `dot` only if sources changed
3. Pre-commit hook stages the updated diagrams automatically
4. **Strict review mode** (optional) rejects the commit if diagrams changed
   but an architecture doc wasn't also staged

### Differences from the Go version (ideal flow)

- **No call graph**: pyreverse generates package-level dependency graphs
  rather than function-level call graphs. For Python call graphs, consider
  supplementing with [pyan3](https://github.com/Technologicat/pyan) or
  [code2flow](https://github.com/scottrogowski/code2flow).
- **No connected-class analysis**: the Go version uses `gopls` references to
  show which types are affected by structural changes. The Python version
  does not yet have an equivalent (potential future enhancement using
  `jedi`, `pyright`, or AST-based analysis).
- **Simpler change detection**: since pyreverse output is deterministic, SHA256
  comparison is used for both output files (the Go version needs
  byte-frequency matching for non-deterministic go-callvis output).

## Prerequisites

```bash
# Required
pip install pylint           # provides pyreverse
apt install graphviz         # provides dot command
```

## Setup

### 1. Copy the scripts

```bash
cp generate-diagrams.sh /path/to/your/project/scripts/
chmod +x /path/to/your/project/scripts/generate-diagrams.sh

cp pre-commit /path/to/your/project/.githooks/
chmod +x /path/to/your/project/.githooks/pre-commit
```

### 2. Configure git to use the hooks directory

```bash
cd /path/to/your/project
git config core.hooksPath .githooks
```

### 3. Create output directory

```bash
mkdir -p docs/diagrams/generated
```

### 4. (Optional) Add configuration

```bash
cp diagrams.sample.conf /path/to/your/project/diagrams.conf
# Edit SOURCE_DIRS, PROJECT_NAME, etc.
```

### 5. (Optional) Enable strict review mode

```bash
git config docs.strictReview true
```

## Configuration

All options are set in `diagrams.conf` in the repo root. See
[diagrams.sample.conf](diagrams.sample.conf) for the full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `DIAGRAMS_DIR` | `docs/diagrams/generated` | Where diagrams are written |
| `GENERATE_SCRIPT` | `scripts/generate-diagrams.sh` | Path to the generate script |
| `REVIEW_FILE` | `docs/architecture.md` | File required in strict review mode |
| `SOURCE_DIRS` | `("src")` | Directories to scan (bash array) |
| `PROJECT_NAME` | (auto-detected) | Name used in pyreverse output filenames |
| `PYREVERSE_FLAGS` | `""` | Additional flags for pyreverse |

## Manual usage

```bash
# Generate/update diagrams
./scripts/generate-diagrams.sh

# Check if diagrams are stale (useful in CI)
./scripts/generate-diagrams.sh --check

# Force regeneration
./scripts/generate-diagrams.sh --force
```
