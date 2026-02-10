#!/usr/bin/env bash
#
# Generate class and package diagrams from Python source using pyreverse
#
# Usage: generate-diagrams.sh [--check] [--force]
#
# Options:
#   --check    Check if diagrams are stale (exit 1 if regeneration needed)
#   --force    Force regeneration even if diagrams are up-to-date
#
# Configuration: diagrams.conf in repo root (optional)
#   See diagrams.sample.conf for available options.
#
# Prerequisites:
#   - pyreverse (part of pylint): pip install pylint
#   - graphviz (dot command): apt install graphviz
#
# EXPERIMENTAL: This hook has not been tested against real projects.
# Please report issues and suggest improvements.

set -o pipefail


## exit codes ##################################################################
################################################################################

function _setup-exit-codes() {
    :  'Set up exit code constants'
    declare -gr E_SUCCESS=0
    declare -gr E_ERROR=1
    declare -gr E_STALE=2
}


## colors ######################################################################
################################################################################

function _setup-colors() {
    :  'Set up color variables'
    local -- __red=$'\033[31m'
    local -- __green=$'\033[32m'
    local -- __yellow=$'\033[33m'
    local -- __blue=$'\033[34m'
    local -- __reset=$'\033[0m'

    declare -g C_ERROR="${__red}"
    declare -g C_SUCCESS="${__green}"
    declare -g C_WARN="${__yellow}"
    declare -g C_INFO="${__blue}"
    declare -g C_RESET="${__reset}"
}

function _unset-colors() {
    :  'Unset color variables for non-terminal output'
    declare -g C_ERROR=""
    declare -g C_SUCCESS=""
    declare -g C_WARN=""
    declare -g C_INFO=""
    declare -g C_RESET=""
}


## helpful functions ###########################################################
################################################################################

function error() {
    echo -e "${C_ERROR}[ERROR]${C_RESET} ${1}" >&2
}

function warn() {
    echo -e "${C_WARN}[WARN]${C_RESET} ${1}" >&2
}

function info() {
    echo -e "${C_INFO}[INFO]${C_RESET} ${1}"
}

function success() {
    echo -e "${C_SUCCESS}[OK]${C_RESET} ${1}"
}

function require-command() {
    :  'Check if a command exists

        @arg cmd   Command name to check
        @arg hint  Installation hint if not found
        @stdout    Path to the command if found
        @return    0 if found, 1 if not
    '
    local -- __cmd="${1}"
    local -- __hint="${2:-}"

    if command -v "${__cmd}" &>/dev/null; then
        echo "${__cmd}"
        return ${E_SUCCESS}
    fi

    if [[ -n "${__hint}" ]]; then
        error "${__cmd} not found - ${__hint}"
    else
        error "${__cmd} not found"
    fi
    return ${E_ERROR}
}


## core functions ##############################################################
################################################################################

function _detect-project-name() {
    :  'Auto-detect the project name from pyproject.toml, setup.cfg, or dirname

        Checks (in order):
        1. pyproject.toml [project] name
        2. setup.cfg [metadata] name
        3. Basename of PROJECT_ROOT
    '
    local -- __name=""

    # Try pyproject.toml
    if [[ -f "${PROJECT_ROOT}/pyproject.toml" ]]; then
        __name=$(grep -A5 '^\[project\]' "${PROJECT_ROOT}/pyproject.toml" \
            | grep '^name' | head -1 \
            | sed 's/^name[[:space:]]*=[[:space:]]*["'"'"']\([^"'"'"']*\)["'"'"'].*/\1/')
    fi

    # Try setup.cfg
    if [[ -z "${__name}" ]] && [[ -f "${PROJECT_ROOT}/setup.cfg" ]]; then
        __name=$(grep -A5 '^\[metadata\]' "${PROJECT_ROOT}/setup.cfg" \
            | grep '^name' | head -1 \
            | sed 's/^name[[:space:]]*=[[:space:]]*//')
    fi

    # Fallback to directory name
    if [[ -z "${__name}" ]]; then
        __name="${PROJECT_ROOT##*/}"
    fi

    echo "${__name}"
}

function _generate-source-files() {
    :  'Generate .dot source files from Python source using pyreverse

        @return
            0 on success, 1 on failure
    '
    local -- __pyreverse_bin

    __pyreverse_bin=$(require-command pyreverse "pip install pylint") || return ${E_ERROR}

    info "Generating class and package diagrams..."

    # pyreverse generates classes_<name>.dot and packages_<name>.dot
    # Use a temp directory to avoid polluting the project, then move
    local -- __tmpdir
    __tmpdir=$(mktemp -d)

    # shellcheck disable=SC2086
    if ! "${__pyreverse_bin}" -o dot -p "${PROJECT_NAME}" \
            ${PYREVERSE_FLAGS} \
            -d "${__tmpdir}" \
            "${SOURCE_DIRS[@]}" 2>&1; then
        error "pyreverse failed"
        rm -rf "${__tmpdir}"
        return ${E_ERROR}
    fi

    # Move generated files to diagrams dir as .new
    if [[ -f "${__tmpdir}/classes_${PROJECT_NAME}.dot" ]]; then
        mv "${__tmpdir}/classes_${PROJECT_NAME}.dot" "${DIAGRAMS_DIR}/classes.dot.new"
    else
        warn "pyreverse did not generate classes_${PROJECT_NAME}.dot"
    fi

    if [[ -f "${__tmpdir}/packages_${PROJECT_NAME}.dot" ]]; then
        mv "${__tmpdir}/packages_${PROJECT_NAME}.dot" "${DIAGRAMS_DIR}/packages.dot.new"
    else
        warn "pyreverse did not generate packages_${PROJECT_NAME}.dot"
    fi

    rm -rf "${__tmpdir}"
    return ${E_SUCCESS}
}

function _check-sources-changed() {
    :  'Compare new source files against existing ones

        pyreverse output is deterministic, so simple diff is sufficient.

        @return
            0 if sources changed (or no existing files), 1 if identical
    '
    local -- __classes_changed=false
    local -- __packages_changed=false

    if [[ -f "${DIAGRAMS_DIR}/classes.dot.new" ]]; then
        if [[ ! -f "${DIAGRAMS_DIR}/classes.dot" ]]; then
            __classes_changed=true
        elif ! diff -q "${DIAGRAMS_DIR}/classes.dot" "${DIAGRAMS_DIR}/classes.dot.new" &>/dev/null; then
            __classes_changed=true
        fi
    fi

    if [[ -f "${DIAGRAMS_DIR}/packages.dot.new" ]]; then
        if [[ ! -f "${DIAGRAMS_DIR}/packages.dot" ]]; then
            __packages_changed=true
        elif ! diff -q "${DIAGRAMS_DIR}/packages.dot" "${DIAGRAMS_DIR}/packages.dot.new" &>/dev/null; then
            __packages_changed=true
        fi
    fi

    if ${__classes_changed} || ${__packages_changed}; then
        return 0  # Changed
    fi
    return 1  # Identical
}

function _render-svgs() {
    :  'Render SVG files from .dot source files'

    if [[ -f "${DIAGRAMS_DIR}/classes.dot" ]]; then
        info "Rendering class diagram SVG..."
        if ! dot -Tsvg "${DIAGRAMS_DIR}/classes.dot" -o "${DIAGRAMS_DIR}/classes.svg"; then
            error "GraphViz rendering failed for classes.dot"
            return ${E_ERROR}
        fi
    fi

    if [[ -f "${DIAGRAMS_DIR}/packages.dot" ]]; then
        info "Rendering package diagram SVG..."
        if ! dot -Tsvg "${DIAGRAMS_DIR}/packages.dot" -o "${DIAGRAMS_DIR}/packages.svg"; then
            error "GraphViz rendering failed for packages.dot"
            return ${E_ERROR}
        fi
    fi

    return ${E_SUCCESS}
}

function _commit-source-files() {
    :  'Move .new source files to final locations'
    [[ -f "${DIAGRAMS_DIR}/classes.dot.new" ]] && \
        mv "${DIAGRAMS_DIR}/classes.dot.new" "${DIAGRAMS_DIR}/classes.dot"
    [[ -f "${DIAGRAMS_DIR}/packages.dot.new" ]] && \
        mv "${DIAGRAMS_DIR}/packages.dot.new" "${DIAGRAMS_DIR}/packages.dot"
}

function _cleanup-temp-files() {
    :  'Remove temporary .new files'
    rm -f "${DIAGRAMS_DIR}/classes.dot.new"
    rm -f "${DIAGRAMS_DIR}/packages.dot.new"
}

function _do-check() {
    :  'Check if diagrams are stale

        @return
            0 if up-to-date, E_STALE if regeneration needed
    '
    info "Checking if diagrams are stale..."

    _generate-source-files || return ${E_ERROR}

    if _check-sources-changed; then
        _cleanup-temp-files
        warn "Diagrams are stale - regeneration needed"
        return ${E_STALE}
    fi

    _cleanup-temp-files
    success "Diagrams are up-to-date"
    return ${E_SUCCESS}
}

function _do-generate() {
    :  'Generate documentation diagrams

        @arg force  If true, regenerate even if up-to-date
    '
    local -- __force="${1:-false}"

    info "Generating documentation diagrams..."
    echo ""

    _generate-source-files || return ${E_ERROR}

    if ! ${__force} && ! _check-sources-changed; then
        _cleanup-temp-files
        success "Diagrams are up-to-date, skipping SVG render"
        return ${E_SUCCESS}
    fi

    _commit-source-files

    _render-svgs || return ${E_ERROR}

    echo ""
    success "All diagrams generated!"
    echo ""
    echo "Generated files:"
    ls -lh "${DIAGRAMS_DIR}"/*.svg 2>/dev/null
    echo ""

    return ${E_SUCCESS}
}


## initialization ##############################################################
################################################################################

function _parse-args() {
    :  'Parse command-line arguments'
    declare -g DO_CHECK=false
    declare -g DO_FORCE=false

    while [[ ${#} -gt 0 ]]; do
        case "${1}" in
            --check)
                DO_CHECK=true
                shift
                ;;
            --force)
                DO_FORCE=true
                shift
                ;;
            -h|--help)
                __help-usage
                return ${E_ERROR}
                ;;
            *)
                error "Unknown option: ${1}"
                __help-usage
                return ${E_ERROR}
                ;;
        esac
    done

    return ${E_SUCCESS}
}

function __help-usage() {
    :  'Print usage information'
    cat << '    EOF'
Usage: generate-diagrams.sh [--check] [--force]

Generate class and package diagrams from Python source using pyreverse.

Options:
  --check    Check if diagrams are stale (exit 1 if regeneration needed)
  --force    Force regeneration even if diagrams are up-to-date
  -h, --help Show this help

Configuration:
  Place a diagrams.conf in your repo root to customize behavior.
  See diagrams.sample.conf for available options.
    EOF
}

function _load-config() {
    :  'Load configuration from diagrams.conf in repo root'
    local -- __conf="${PROJECT_ROOT}/diagrams.conf"
    if [[ -f "${__conf}" ]]; then
        # shellcheck source=/dev/null
        source "${__conf}"
    fi
}

function _setup() {
    :  'Set up the environment'
    if [[ -t 1 ]]; then
        _setup-colors
    else
        _unset-colors
    fi

    # Detect project root from git
    declare -g PROJECT_ROOT
    PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
    if [[ -z "${PROJECT_ROOT}" ]]; then
        error "Not inside a git repository"
        return ${E_ERROR}
    fi

    # Defaults (can be overridden by config)
    declare -g DIAGRAMS_DIR="${PROJECT_ROOT}/docs/diagrams/generated"
    declare -g -a SOURCE_DIRS=("${PROJECT_ROOT}/src")
    declare -g PROJECT_NAME=""
    declare -g PYREVERSE_FLAGS=""

    # Load config (may override the above)
    _load-config

    # Auto-detect project name if not configured
    if [[ -z "${PROJECT_NAME}" ]]; then
        PROJECT_NAME=$(_detect-project-name)
    fi

    info "Project: ${PROJECT_NAME}"

    # Ensure output directory exists
    mkdir -p "${DIAGRAMS_DIR}"

    return ${E_SUCCESS}
}


## main ########################################################################
################################################################################

function main() {
    _setup-exit-codes
    _parse-args "${@}" || return ${?}
    _setup || return ${?}

    if ${DO_CHECK}; then
        _do-check
        return ${?}
    fi

    _do-generate "${DO_FORCE}"
    return ${?}
}


## run #########################################################################
################################################################################

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && main "${@}"
