# Diagram Generation Hooks

Git hooks that automatically generate and maintain architecture diagrams from
source code. Diagrams are regenerated on commit whenever source files change,
keeping documentation in sync with the codebase.

## Purpose

Architecture diagrams go stale. These hooks solve that by treating diagrams as
derived artifacts — generated from the AST, diffed on commit, and optionally
gating commits that change structure without updating documentation.

The result: diagrams that are always accurate, diffs that are always meaningful,
and architecture docs that stay honest.

## Ideal flow (based on Go implementation)

The [Go hooks](golang/) represent the most complete implementation. Here's how
the ideal flow works end-to-end:

### On commit

```
1. Developer stages source files
2. Pre-commit hook detects staged files matching the language
3. Hook calls the generate script
4. Generate script:
   a. Runs AST analysis tools to produce diagram source files (.puml, .gv, .mmd, .dot)
   b. Compares new sources against existing using smart diffing:
      - Deterministic output: simple text diff / SHA256
      - Non-deterministic output: byte-frequency matching (handles tools
        that reorder attributes between runs)
   c. If unchanged: exits early, no SVG render needed
   d. If changed: renders source files to SVG
5. Pre-commit hook auto-stages updated diagram files
6. [Strict review mode] If diagrams changed structurally:
   a. Computes fingerprints and compares against tracking file
   b. If fingerprints differ from last verified state:
      - Generates a review context showing:
        * Diff of structural changes
        * Connected types/modules affected by the change
        * Relationship categorization (creates, field, param, returns, uses)
      - Checks if the review file (e.g., architecture.md) is staged
      - If not staged: REJECTS the commit with actionable instructions
      - If staged: updates tracking file and allows commit
```

### Strict review mode

Enabled per-project via `git config docs.strictReview true`. When active, the
hook enforces that architecture documentation is updated alongside structural
changes. This creates a lightweight review loop:

1. Diagrams change because code changed
2. Developer is shown exactly what changed and what's affected
3. Developer updates the architecture doc to reflect the changes
4. Both the diagrams and the doc are committed together

Bypass with `git commit --no-verify` when needed. Disable entirely with
`git config docs.strictReview false`.

### Diagram types

The ideal setup generates two complementary views:

| Diagram | Shows | Tool example |
|---------|-------|-------------|
| **Class/type diagram** | Structs/classes, interfaces, fields, methods, inheritance | goplantuml, pyreverse, acorn |
| **Dependency graph** | Module/package imports, function call relationships | go-callvis, pyreverse, acorn |

### Connected-type analysis

The Go implementation uses `gopls` (the Go language server) to provide rich
context when diagrams change:

- **What types reference the changed type** (and how: field, param, return, etc.)
- **What types the changed type references** (struct field types)
- **Enclosing context** (which method/function contains the reference)

This analysis makes the review context actionable — instead of just "Config
changed", you see "Config changed, and TestHarness creates it in SpawnClaude(),
and Runner uses it as a field."

## Language implementations

### [Go](golang/) — Production-ready

The gold standard. Generates PlantUML class diagrams and GraphViz call graphs
from Go AST using `goplantuml` and `go-callvis`. Full strict review mode with
`gopls`-powered connected-type analysis. Byte-frequency matching handles
non-deterministic go-callvis output.

| Feature | Status |
|---------|--------|
| Class/type diagrams | goplantuml → PlantUML → SVG |
| Call graphs | go-callvis → GraphViz → SVG |
| Smart diffing | SHA256 (deterministic) + byte-frequency (non-deterministic) |
| Strict review mode | Full, with tracking file |
| Connected-type analysis | gopls references + relationship categorization |
| Configuration | `diagrams.conf` (bash-sourced) |

### [JavaScript](javascript/) — Production-ready

Uses `acorn` for AST parsing to generate deterministic Mermaid diagrams. The
validation script provides graph-based diff analysis with consumer detection,
dead-end identification, and orphan module detection — a different but equally
rich approach to the Go version's gopls analysis.

| Feature | Status |
|---------|--------|
| Class/type diagrams | acorn AST → Mermaid classDiagram → SVG |
| Module dependency graph | acorn imports → Mermaid graph LR → SVG |
| Smart diffing | Text comparison (output is deterministic) |
| Strict review mode | Full, with graph-data.json tracking |
| Connected-type analysis | Graph-based: consumers, dead ends, orphans |
| Configuration | `diagrams.json` |

**Differences from Go:**
- Three scripts instead of two (generate + validate + pre-commit wrapper)
- Graph data stored as JSON for structured diff analysis
- No function-level call graph (module-level dependencies instead)
- Consumer analysis via import graph rather than language server

### [Python](python/) — Experimental

Uses `pyreverse` (from pylint) for class and package diagrams rendered via
graphviz. Follows the Go version's script structure but with simpler analysis.

| Feature | Status |
|---------|--------|
| Class/type diagrams | pyreverse → GraphViz DOT → SVG |
| Package dependency graph | pyreverse → GraphViz DOT → SVG |
| Smart diffing | SHA256 (pyreverse output is deterministic) |
| Strict review mode | Fingerprinting + tracking, no detailed diff context |
| Connected-type analysis | Not implemented |
| Configuration | `diagrams.conf` (bash-sourced) |

**Differences from Go:**
- No function-level call graph (package-level dependencies only)
- No connected-type analysis (no gopls equivalent yet — could use jedi/pyright)
- No detailed diff context in strict review (shows that diagrams changed, but
  not a structural breakdown of what changed)
- Project name auto-detected from `pyproject.toml` / `setup.cfg`
