# JavaScript Diagram Generation Hooks

Automatically generate and maintain module dependency diagrams and class
hierarchy diagrams from JavaScript source code. Diagrams are regenerated on
commit when JS files change, keeping architecture documentation in sync.

## What it generates

- **Module dependencies** (`module-dependencies.mmd` / `.svg`) -- Mermaid `graph LR`
  showing file-level imports, grouped by directory
- **Class hierarchy** (`class-hierarchy.mmd` / `.svg`) -- Mermaid `classDiagram`
  with public API (properties + methods) and inheritance
- **Graph data** (`graph-data.json`) -- structured representation used for
  diff analysis and validation

## How it works

1. **Pre-commit hook** detects staged `.js` files (configurable pattern)
2. Calls **validate-architecture.mjs** which:
   - Calls **generate-diagrams.mjs** to parse source via acorn AST
   - Compares against committed diagram files (deterministic text comparison)
   - If changed, writes updated files and generates a diff report:
     - Added/removed/modified modules
     - Class changes (methods, properties, inheritance)
     - Consumer analysis (which modules import what changed)
     - Dead-end detection (exported but never imported)
     - Orphan detection (no imports and no exports)
   - Checks if the review file is staged
   - Blocks commit if review file is missing
3. Pre-commit hook auto-stages updated diagram files

## Prerequisites

```bash
# Required (add to your project)
npm install --save-dev acorn acorn-walk

# Optional (for SVG rendering)
npm install --save-dev @mermaid-js/mermaid-cli
```

## Setup

### 1. Copy the scripts

```bash
# Copy the generation and validation scripts
cp generate-diagrams.mjs /path/to/your/project/tools/
cp validate-architecture.mjs /path/to/your/project/tools/

# Copy the pre-commit hook
cp pre-commit /path/to/your/project/.githooks/
chmod +x /path/to/your/project/.githooks/pre-commit
```

### 2. Configure git to use the hooks directory

```bash
cd /path/to/your/project
git config core.hooksPath .githooks
```

### 3. Add npm scripts (optional but recommended)

```json
{
    "scripts": {
        "diagrams": "node tools/generate-diagrams.mjs",
        "diagrams:check": "node tools/generate-diagrams.mjs --check",
        "validate": "node tools/validate-architecture.mjs"
    }
}
```

### 4. Add configuration

```bash
cp diagrams.sample.json /path/to/your/project/diagrams.json
# Edit scanDirs, reviewFile, etc. to match your project
```

### 5. Create initial diagrams

```bash
mkdir -p docs/diagrams
npm run diagrams
```

## Configuration

All options are set in `diagrams.json` in the repo root. See
[diagrams.sample.json](diagrams.sample.json) for the full list.

| Key | Default | Description |
|-----|---------|-------------|
| `scanDirs` | `["src"]` | Directories to scan for source files |
| `diagramsDir` | `"docs/diagrams"` | Where diagrams are written |
| `reviewFile` | `"docs/ARCHITECTURE.md"` | File required when diagrams change |
| `validateScript` | `"tools/validate-architecture.mjs"` | Path to the validation script |
| `triggerPattern` | `"\\.js$"` | Regex for files that trigger validation |
| `entryPatterns` | `["main\\.js$", "index\\.js$"]` | Entry points excluded from dead-end detection |
| `extensions` | `[".js"]` | File extensions to scan (e.g., add `".mjs"`) |
| `baseDir` | (auto-detected) | Base directory for relative path computation |

## Manual usage

```bash
# Generate/update all diagrams
npm run diagrams

# Check if diagrams are stale (useful in CI)
npm run diagrams:check

# Run full validation (same as pre-commit)
npm run validate
```

## Architecture review

When diagrams change, the validation script blocks the commit with a report
showing exactly what changed structurally. Update your review file to reflect
the changes, stage it, and retry.

Bypass for a single commit:
```bash
git commit --no-verify
```
