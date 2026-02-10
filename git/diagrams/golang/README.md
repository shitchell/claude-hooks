# Go Diagram Generation Hooks

Automatically generate and maintain class diagrams and call graphs from Go
source code. Diagrams are regenerated on commit when Go files change, keeping
architecture documentation in sync with the codebase.

## What it generates

- **Class diagram** (`classes.puml` / `classes.svg`) -- structs, interfaces,
  and their relationships via [goplantuml](https://github.com/jfeliu007/goplantuml)
- **Call graph** (`callgraph.gv` / `callgraph.svg`) -- function call
  relationships via [go-callvis](https://github.com/ofabry/go-callvis)

## How it works

1. **Pre-commit hook** detects staged `.go` files
2. Calls **generate-diagrams.sh** which:
   - Runs `goplantuml` and `go-callvis` to produce source files (`.puml`, `.gv`)
   - Compares against existing sources using smart diffing:
     - SHA256 for `.puml` (deterministic output)
     - Byte-frequency matching for `.gv` (handles non-deterministic attribute ordering)
   - Renders SVGs only if sources actually changed
3. Pre-commit hook stages the updated diagrams automatically
4. **Strict review mode** (optional) rejects the commit if diagrams changed
   but an architecture doc wasn't also staged, with a detailed diff showing
   what changed and which classes are affected (uses `gopls` when available)

## Prerequisites

```bash
# Required
go install github.com/jfeliu007/goplantuml/cmd/goplantuml@latest
go install github.com/ofabry/go-callvis@latest
apt install graphviz    # or equivalent for your OS

# Required for class diagram SVG rendering
apt install default-jre # PlantUML jar is downloaded automatically

# Optional (enhances strict review context)
go install golang.org/x/tools/gopls@latest
```

## Setup

### 1. Copy the scripts

```bash
# Copy the generate script
cp generate-diagrams.sh /path/to/your/project/scripts/
chmod +x /path/to/your/project/scripts/generate-diagrams.sh

# Copy the pre-commit hook
cp pre-commit /path/to/your/project/.githooks/
chmod +x /path/to/your/project/.githooks/pre-commit
```

### 2. Configure git to use the hooks directory

```bash
cd /path/to/your/project
git config core.hooksPath .githooks
```

Or if you already have a pre-commit hook, add a call to this one.

### 3. Create output directory

```bash
mkdir -p docs/diagrams/generated
```

### 4. (Optional) Add configuration

```bash
cp diagrams.sample.conf /path/to/your/project/diagrams.conf
# Edit as needed
```

### 5. (Optional) Enable strict review mode

```bash
cd /path/to/your/project
git config docs.strictReview true
```

## Configuration

All options are set in `diagrams.conf` in the repo root. See
[diagrams.sample.conf](diagrams.sample.conf) for the full list.

Key options:

| Variable | Default | Description |
|----------|---------|-------------|
| `DIAGRAMS_DIR` | `docs/diagrams/generated` | Where diagrams are written |
| `GENERATE_SCRIPT` | `scripts/generate-diagrams.sh` | Path to the generate script |
| `REVIEW_FILE` | `docs/architecture.md` | File required in strict review mode |
| `GOPLANTUML_FLAGS` | `-recursive` | Flags for goplantuml |
| `CALLVIS_FLAGS` | `-format dot` | Flags for go-callvis |

## Manual usage

```bash
# Generate/update diagrams
./scripts/generate-diagrams.sh

# Check if diagrams are stale (useful in CI)
./scripts/generate-diagrams.sh --check

# Force regeneration
./scripts/generate-diagrams.sh --force
```

## Strict review mode

When enabled (`git config docs.strictReview true`), the pre-commit hook:

1. Tracks verified diagram fingerprints in a `.tracking` file
2. Compares current fingerprints after regeneration
3. If diagrams changed, checks whether the review file is staged
4. If not staged, shows a detailed review context:
   - Diff of structural changes in the class diagram
   - Connected classes and their relationships (via `gopls` or grep fallback)
   - Instructions for what to review
5. Rejects the commit until the review file is staged

Bypass for a single commit:
```bash
git commit --no-verify
```

Disable permanently:
```bash
git config docs.strictReview false
```
