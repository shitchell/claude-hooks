# TypeScript Diagram Generation Hooks

Automatically generate and maintain module dependency diagrams and class
hierarchy diagrams from TypeScript source code. Diagrams are regenerated on
commit when `.ts`/`.tsx` files change, keeping architecture documentation in
sync with the codebase.

## What it generates

- **Module dependencies** (`module-dependencies.mmd` / `.svg`) -- Mermaid `graph LR`
  showing file-level imports, grouped by directory into subgraphs
- **Class hierarchy** (`class-hierarchy.mmd` / `.svg`) -- Mermaid `classDiagram`
  with interfaces, abstract classes, concrete classes, enums, public properties
  and methods, and inheritance/implementation relationships
- **Graph data** (`graph-data.json`) -- structured JSON representation used for
  diff analysis and connected-type analysis during validation

## How it works

1. **Pre-commit hook** detects staged `.ts`/`.tsx` files (configurable pattern)
2. Calls **validate-architecture.mjs** which:
   - Calls **generate-diagrams.mjs** to parse source files using the TypeScript
     compiler API (`ts.createSourceFile()` for fast per-file AST parsing)
   - Compares generated diagrams against existing files (deterministic text
     comparison -- output is fully sorted)
   - If changed, writes updated `.mmd` and `graph-data.json` files
   - Diffs the old and new graph data to identify structural changes:
     - Added/removed/modified modules
     - Class/interface/enum changes (methods, properties, inheritance)
     - Import and export changes
   - Runs **connected-type analysis** using the full TypeScript compiler
     (`ts.createProgram()` with type checking) to find all references to
     changed types across the codebase, categorized by relationship
   - Compares SHA256 fingerprints against a `.tracking` file
   - If fingerprints differ and the review file is not staged: **blocks the
     commit** with a detailed report showing what changed and what's affected
   - If the review file is staged: updates the tracking file and allows the
     commit
3. Pre-commit hook auto-stages updated diagram files

## Prerequisites

```bash
# Required (already present in any TypeScript project)
npm install --save-dev typescript

# Optional (for SVG rendering of .mmd files)
npm install --save-dev @mermaid-js/mermaid-cli
```

No external tools beyond Node.js and the `typescript` package. The TypeScript
compiler API handles both diagram generation (per-file AST parsing) and
connected-type analysis (full program type checking).

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

Or if you already have a pre-commit hook, add a call to this one.

### 3. Create output directory

```bash
mkdir -p docs/diagrams
```

### 4. (Optional) Add configuration

```bash
cp diagrams.sample.json /path/to/your/project/diagrams.json
# Edit scanDirs, reviewFile, tsconfig, etc. to match your project
```

### 5. (Optional) Enable strict review mode

```bash
cd /path/to/your/project
git config docs.strictReview true
```

When strict review mode is disabled (the default), the pre-commit hook warns
about stale diagrams but allows the commit to proceed. When enabled, it blocks
the commit until the review file is staged.

### 6. Generate initial diagrams

```bash
node tools/generate-diagrams.mjs
```

## Configuration

All options are set in `diagrams.json` in the repo root. See
[diagrams.sample.json](diagrams.sample.json) for the full list.

| Key | Default | Description |
|-----|---------|-------------|
| `scanDirs` | `["src"]` | Directories to scan for source files |
| `diagramsDir` | `"docs/diagrams"` | Where diagrams are written |
| `reviewFile` | `"docs/ARCHITECTURE.md"` | File required when diagrams change (strict review mode) |
| `validateScript` | `"tools/validate-architecture.mjs"` | Path to the validation script |
| `triggerPattern` | `"\\.tsx?$"` | Regex for files that trigger validation in pre-commit |
| `entryPatterns` | `["index\\.ts$"]` | Entry points excluded from dead-end detection |
| `extensions` | `[".ts", ".tsx"]` | File extensions to scan |
| `tsconfig` | `"tsconfig.json"` | Path to tsconfig.json (used for connected-type analysis) |
| `baseDir` | (auto-detected) | Base directory for relative path computation |

## Manual usage

```bash
# Generate/update all diagrams
node tools/generate-diagrams.mjs

# Check if diagrams are stale (useful in CI -- exits 0 if up-to-date, 2 if stale)
node tools/generate-diagrams.mjs --check

# Force regeneration (even if up-to-date)
node tools/generate-diagrams.mjs --force

# Dump parse results for a single file (debug)
node tools/generate-diagrams.mjs --dump src/core/types.ts
```

## Strict review mode

When enabled (`git config docs.strictReview true`), the pre-commit hook:

1. Tracks verified diagram fingerprints in a `.tracking` file (SHA256 hashes
   of the `.mmd` files, bash-sourceable format matching the Go variant)
2. Compares current fingerprints after regeneration
3. If diagrams changed, checks whether the review file is staged
4. If not staged, shows a detailed review context:
   - Diff of structural changes (added/removed/modified modules, classes,
     interfaces, enums, functions, imports, exports)
   - Connected types and their relationships (via TypeScript compiler API)
   - Consumer analysis (which modules import the changed modules)
   - Dead-end and orphan detection
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

## Connected-type analysis

The validation script uses the TypeScript compiler API (`ts.createProgram()`)
to find all references to types that changed structurally. This matches the
Go variant's `gopls`-powered analysis but uses TypeScript's own type system
instead.

When a type changes, the analysis walks the entire program AST and categorizes
every reference by relationship:

| Relationship | Meaning | Example |
|-------------|---------|---------|
| **creates** | Instantiation via `new` or direct call | `new Config()` |
| **param** | Used as a function/method parameter type | `(config: Config)` |
| **returns** | Used as a function/method return type | `(): Config` |
| **field** | Used as a property/field type | `config: Config` |
| **extends** | Used in an extends or implements clause | `class Foo extends Config` |
| **uses** | Any other reference (property access, etc.) | `Config.DEFAULT` |

Each reference includes:
- **Connected type** -- the class/interface/function containing the reference
- **Method** -- the specific method within the connected type (if applicable)
- **Location** -- file path and line number

### Testing connected-type analysis

```bash
# Find all references to a specific type
node tools/validate-architecture.mjs --test-connections TestDevice

# Test fingerprinting
node tools/validate-architecture.mjs --test-fingerprints
```
