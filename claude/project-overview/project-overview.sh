#!/usr/bin/env bash
#
# project-overview.sh - Generate a project structure overview for Claude
#
# Prints a markdown-formatted overview of the current project to stdout,
# including a tree listing, notable files, and contents of key docs.
# Intended as a Claude Code SessionStart hook.
#
# Configuration: .claude/project-overview.conf
#   Configs are sourced walk-forward from ~ to $PWD. Each level can
#   override or extend previous settings. Later configs take priority.
#
#   File/directory patterns use find's -name glob syntax by default:
#     foo.txt        => -name 'foo.txt'        (match anywhere by name)
#     docs/foo.txt   => -path '*/docs/foo.txt'  (match relative structure)
#     /docs/foo.txt  => -path '$PWD/docs/foo.txt' (match from project root)
#
# Usage:
#   Called by Claude Code SessionStart hook, or manually:
#   bash ~/.claude/hooks/project-overview.sh

set -euo pipefail

# ============================================================================
# Defaults
# ============================================================================

ENABLED=true
REQUIRE_GIT=false
MAX_DEPTH=3

# Directories to exclude from the tree listing (find -name globs)
EXCLUDE_DIRS=(
    .git node_modules vendor bower_components
    __pycache__ .venv venv .tox .eggs
    .mypy_cache .pytest_cache .ruff_cache .coverage
    dist build target out
    .next .nuxt .output .cache .parcel-cache
    .terraform .terragrunt-cache
)
EXCLUDE_DIRS_EXTRA=()

# Directories to call out as documentation
DOC_DIRS=(docs doc .github)
DOC_DIRS_EXTRA=()

# Root-level files to highlight as notable (find -name globs)
DOC_FILES=(
    'README*' 'CONTRIBUTING*' 'CHANGELOG*' 'LICENSE*' 'ARCHITECTURE*'
    CLAUDE.md
    package.json Cargo.toml pyproject.toml go.mod composer.json Gemfile
    Makefile CMakeLists.txt Justfile Taskfile.yml
    Dockerfile docker-compose.yml docker-compose.yaml
    .env.example
)
DOC_FILES_EXTRA=()

# Files whose contents are printed when found (searched anywhere in tree)
CAT_PATTERNS=(INDEX.md)
CAT_PATTERNS_EXTRA=()

# ============================================================================
# Config loading — walk forward from ~ to $PWD
# ============================================================================

load_configs() {
    local config_name="project-overview.conf"
    local target="$PWD"
    local home="$HOME"

    # Build list of directories from ~ to $PWD
    local -a config_dirs=("$home")

    if [[ "$target" == "$home"/* ]]; then
        local relative="${target#"$home"/}"
        local current="$home"
        IFS='/' read -ra parts <<< "$relative"
        for part in "${parts[@]}"; do
            current="$current/$part"
            config_dirs+=("$current")
        done
    elif [[ "$target" != "$home" ]]; then
        # PWD is outside ~ — still check its local config
        config_dirs+=("$target")
    fi

    # Source each config that exists
    for dir in "${config_dirs[@]}"; do
        local conf="$dir/.claude/$config_name"
        if [[ -f "$conf" ]]; then
            # shellcheck source=/dev/null
            source "$conf"
        fi
    done
}

# ============================================================================
# Utility functions
# ============================================================================

# Append _EXTRA array into base array
merge_extra() {
    local -n _base="$1"
    local -n _extra="$2"
    if [[ ${#_extra[@]} -gt 0 ]]; then
        _base+=("${_extra[@]}")
    fi
}

# Test whether a file path matches a user-supplied pattern.
# Patterns:  bare name  => match basename
#            has /      => match as suffix (*/pattern)
#            starts /   => match from project root (./pattern)
matches_pattern() {
    local pattern="$1"
    local filepath="$2" # relative, like ./src/foo.txt

    if [[ "$pattern" == /* ]]; then
        # Absolute from project root: /docs/foo.txt => ./docs/foo.txt
        [[ "$filepath" == ".${pattern}" ]]
    elif [[ "$pattern" == */* ]]; then
        # Relative path: docs/foo.txt => */docs/foo.txt or ./docs/foo.txt
        [[ "$filepath" == */"$pattern" || "$filepath" == "./$pattern" ]]
    else
        # Bare name: match the basename via glob
        local basename="${filepath##*/}"
        # shellcheck disable=SC2254
        [[ "$basename" == $pattern ]]
    fi
}

# ============================================================================
# Main
# ============================================================================

main() {
    load_configs

    # Merge base + extra arrays
    merge_extra EXCLUDE_DIRS EXCLUDE_DIRS_EXTRA
    merge_extra DOC_DIRS DOC_DIRS_EXTRA
    merge_extra DOC_FILES DOC_FILES_EXTRA
    merge_extra CAT_PATTERNS CAT_PATTERNS_EXTRA

    # Check if enabled
    if [[ "$ENABLED" != "true" ]]; then
        return 0
    fi

    # Check git requirement
    if [[ "$REQUIRE_GIT" == "true" ]]; then
        if ! git rev-parse --is-inside-work-tree &>/dev/null; then
            return 0
        fi
    fi

    # --- Collect files via find -------------------------------------------

    # Build prune expression for excluded directories
    local -a prune_expr=()
    for dir in "${EXCLUDE_DIRS[@]}"; do
        if [[ ${#prune_expr[@]} -gt 0 ]]; then
            prune_expr+=(-o)
        fi
        prune_expr+=(-name "$dir" -type d)
    done

    # Run find and collect into array
    local -a files=()
    if [[ ${#prune_expr[@]} -gt 0 ]]; then
        mapfile -t files < <(
            find . -maxdepth "$MAX_DEPTH" \
                \( "${prune_expr[@]}" \) -prune \
                -o -print \
                2>/dev/null | sort
        )
    else
        mapfile -t files < <(
            find . -maxdepth "$MAX_DEPTH" -print 2>/dev/null | sort
        )
    fi

    # Nothing found — nothing to show
    if [[ ${#files[@]} -eq 0 ]]; then
        return 0
    fi

    # --- Check for tree --fromfile support --------------------------------

    local use_tree=false
    if command -v tree &>/dev/null; then
        if printf '.\n' | tree --fromfile /dev/stdin &>/dev/null 2>&1; then
            use_tree=true
        fi
    fi

    # --- Output -----------------------------------------------------------

    local dirname="${PWD##*/}"

    echo "# Project Overview: ${dirname}"
    echo ""

    # Structure section
    echo "## Structure"
    echo ""
    echo '```'
    # Prepare paths: strip ./ prefix, skip . itself
    local -a display_files=()
    for f in "${files[@]}"; do
        [[ "$f" == "." ]] && continue
        display_files+=("${f#./}")
    done

    if [[ "$use_tree" == "true" ]]; then
        # Replace /dev/stdin root label with .
        printf '%s\n' "${display_files[@]}" \
            | tree --fromfile /dev/stdin 2>/dev/null \
            | sed '1s|.*|.|'
    else
        printf '%s\n' "${display_files[@]}"
    fi
    echo '```'
    echo ""

    # Notable files section
    local -a notable=()

    # Check DOC_FILES at project root
    for f in "${files[@]}"; do
        # Skip non-root entries
        local rel="${f#./}"
        [[ "$f" == "." ]] && continue
        [[ "$rel" == */* ]] && continue

        for pattern in "${DOC_FILES[@]}"; do
            # shellcheck disable=SC2254
            if [[ "${f##*/}" == $pattern ]]; then
                notable+=("$rel")
                break
            fi
        done
    done

    # Check DOC_DIRS
    for dir in "${DOC_DIRS[@]}"; do
        if [[ -d "./$dir" ]]; then
            notable+=("$dir/")
        fi
    done

    if [[ ${#notable[@]} -gt 0 ]]; then
        echo "## Notable Files"
        echo ""
        for f in "${notable[@]}"; do
            echo "- ${f}"
        done
        echo ""
    fi

    # Cat sections for matching files
    local -a cat_files=()
    for f in "${files[@]}"; do
        [[ "$f" == "." ]] && continue
        [[ -d "$f" ]] && continue
        for pattern in "${CAT_PATTERNS[@]}"; do
            if matches_pattern "$pattern" "$f"; then
                cat_files+=("$f")
                break
            fi
        done
    done

    for f in "${cat_files[@]}"; do
        local rel="${f#./}"
        echo "## ${f##*/} (${rel})"
        echo ""
        cat "$f"
        echo ""
    done
}

main "$@"
