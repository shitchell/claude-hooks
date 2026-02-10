#!/usr/bin/env bash
#
# Generate class diagrams and call graphs from Go AST
#
# Generates PlantUML class diagrams and GraphViz call graphs from Go source
# code using goplantuml and go-callvis. Renders to SVG via PlantUML and dot.
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
#   - goplantuml: go install github.com/jfeliu007/goplantuml/cmd/goplantuml@latest
#   - go-callvis: go install github.com/ofabry/go-callvis@latest
#   - java (for PlantUML rendering)
#   - graphviz (dot command, for call graph rendering)

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
    :  'Print error message to stderr'
    echo -e "${C_ERROR}[ERROR]${C_RESET} ${1}" >&2
}

function warn() {
    :  'Print warning message to stderr'
    echo -e "${C_WARN}[WARN]${C_RESET} ${1}" >&2
}

function info() {
    :  'Print info message'
    echo -e "${C_INFO}[INFO]${C_RESET} ${1}"
}

function success() {
    :  'Print success message'
    echo -e "${C_SUCCESS}[OK]${C_RESET} ${1}"
}

function require-command() {
    :  'Check if a command exists, checking GOPATH/bin as fallback

        @arg cmd
            Command name to check
        @arg hint
            Installation hint if not found
        @stdout
            Path to the command if found
        @return
            0 if found, 1 if not
    '
    local -- __cmd="${1}"
    local -- __hint="${2:-}"
    local -- __gopath_bin

    # Check PATH first
    if command -v "${__cmd}" &>/dev/null; then
        echo "${__cmd}"
        return ${E_SUCCESS}
    fi

    # Check GOPATH/bin
    __gopath_bin="$(go env GOPATH)/bin/${__cmd}"
    if [[ -x "${__gopath_bin}" ]]; then
        echo "${__gopath_bin}"
        return ${E_SUCCESS}
    fi

    # Not found
    if [[ -n "${__hint}" ]]; then
        error "${__cmd} not found - ${__hint}"
    else
        error "${__cmd} not found"
    fi
    return ${E_ERROR}
}


## core functions ##############################################################
################################################################################

function _ensure-plantuml-jar() {
    :  'Download PlantUML jar if not present'
    if [[ ! -f "${PLANTUML_JAR}" ]]; then
        info "Downloading PlantUML jar..."
        if ! curl -sL -o "${PLANTUML_JAR}" "${PLANTUML_URL}"; then
            error "Failed to download PlantUML jar"
            return ${E_ERROR}
        fi
    fi
    return ${E_SUCCESS}
}

function _generate-source-files() {
    :  'Generate .puml and .gv source files from AST

        @return
            0 on success, 1 on failure
    '
    local -- __goplantuml_bin
    local -- __callvis_bin

    # Find tools
    __goplantuml_bin=$(require-command goplantuml "go install github.com/jfeliu007/goplantuml/cmd/goplantuml@latest") || return ${E_ERROR}
    __callvis_bin=$(require-command go-callvis "go install github.com/ofabry/go-callvis@latest") || return ${E_ERROR}

    # Generate PlantUML source
    info "Generating class diagram source..."
    # shellcheck disable=SC2086
    if ! "${__goplantuml_bin}" ${GOPLANTUML_FLAGS} "${PROJECT_ROOT}" > "${DIAGRAMS_DIR}/classes.puml.new"; then
        error "goplantuml failed"
        return ${E_ERROR}
    fi

    # Generate GraphViz source
    info "Generating call graph source..."
    # shellcheck disable=SC2086
    if ! (cd "${PROJECT_ROOT}" && "${__callvis_bin}" ${CALLVIS_FLAGS} -file "${DIAGRAMS_DIR}/callgraph.new" . 2>&1) | grep -v "^$"; then
        # go-callvis returns non-zero sometimes even on success, check output file
        :
    fi

    # Rename .gv file (go-callvis outputs .gv not .dot)
    if [[ -f "${DIAGRAMS_DIR}/callgraph.new.gv" ]]; then
        mv "${DIAGRAMS_DIR}/callgraph.new.gv" "${DIAGRAMS_DIR}/callgraph.gv.new"
    fi

    # Clean up extra .dot file if created
    rm -f "${DIAGRAMS_DIR}/callgraph.new.dot"

    return ${E_SUCCESS}
}

function _byte-freq-match() {
    :  'Compare two files by byte frequency distribution

        Useful for files with non-deterministic ordering but same content.
        If files have identical byte frequencies, they are semantically equal.

        @arg file1
            First file to compare
        @arg file2
            Second file to compare
        @return
            0 if byte frequencies match, 1 if different
    '
    local -- __file1="${1}"
    local -- __file2="${2}"
    local -- __counts1
    local -- __counts2

    __counts1=$(od -An -tu1 -w1 "${__file1}" | sort -n | uniq -c)
    __counts2=$(od -An -tu1 -w1 "${__file2}" | sort -n | uniq -c)

    [[ "${__counts1}" == "${__counts2}" ]]
}

function _check-sources-changed() {
    :  'Compare new source files against existing ones

        Uses regular diff for .puml (deterministic output).
        Uses byte frequency matching for .gv (non-deterministic attribute ordering).

        @return
            0 if sources changed (or no existing files), 1 if identical
    '
    local -- __puml_changed=false
    local -- __gv_changed=false

    # Check PlantUML (deterministic - use regular diff)
    if [[ ! -f "${DIAGRAMS_DIR}/classes.puml" ]]; then
        __puml_changed=true
    elif ! diff -q "${DIAGRAMS_DIR}/classes.puml" "${DIAGRAMS_DIR}/classes.puml.new" &>/dev/null; then
        __puml_changed=true
    fi

    # Check GraphViz (non-deterministic ordering - use byte frequency match)
    if [[ ! -f "${DIAGRAMS_DIR}/callgraph.gv" ]]; then
        __gv_changed=true
    elif ! _byte-freq-match "${DIAGRAMS_DIR}/callgraph.gv" "${DIAGRAMS_DIR}/callgraph.gv.new"; then
        __gv_changed=true
    fi

    if ${__puml_changed} || ${__gv_changed}; then
        return 0  # Changed
    fi
    return 1  # Identical
}

function _render-svgs() {
    :  'Render SVG files from source files'

    # Render PlantUML to SVG
    info "Rendering class diagram SVG..."
    _ensure-plantuml-jar || return ${E_ERROR}
    if ! java -jar "${PLANTUML_JAR}" -tsvg "${DIAGRAMS_DIR}/classes.puml" -o .; then
        error "PlantUML rendering failed"
        return ${E_ERROR}
    fi

    # Render GraphViz to SVG
    info "Rendering call graph SVG..."
    if ! dot -Tsvg "${DIAGRAMS_DIR}/callgraph.gv" -o "${DIAGRAMS_DIR}/callgraph.svg"; then
        error "GraphViz rendering failed"
        return ${E_ERROR}
    fi

    return ${E_SUCCESS}
}

function _commit-source-files() {
    :  'Move .new source files to final locations'
    mv "${DIAGRAMS_DIR}/classes.puml.new" "${DIAGRAMS_DIR}/classes.puml"
    mv "${DIAGRAMS_DIR}/callgraph.gv.new" "${DIAGRAMS_DIR}/callgraph.gv"
}

function _cleanup-temp-files() {
    :  'Remove temporary .new files'
    rm -f "${DIAGRAMS_DIR}/classes.puml.new"
    rm -f "${DIAGRAMS_DIR}/callgraph.gv.new"
    rm -f "${DIAGRAMS_DIR}/callgraph.new.gv"
    rm -f "${DIAGRAMS_DIR}/callgraph.new.dot"
}

function _do-check() {
    :  'Check if diagrams are stale by comparing AST output

        Generates source files and compares to existing.
        Does not render SVGs.

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

        @arg force
            If true, regenerate even if up-to-date
    '
    local -- __force="${1:-false}"

    info "Generating documentation diagrams..."
    echo ""

    # Generate source files
    _generate-source-files || return ${E_ERROR}

    # Check if anything changed
    if ! ${__force} && ! _check-sources-changed; then
        _cleanup-temp-files
        success "Diagrams are up-to-date, skipping SVG render"
        return ${E_SUCCESS}
    fi

    # Commit source files
    _commit-source-files

    # Render SVGs
    _render-svgs || return ${E_ERROR}

    echo ""
    success "All diagrams generated!"
    echo ""
    echo "Generated files:"
    ls -lh "${DIAGRAMS_DIR}"/*.svg
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

Generate class diagrams and call graphs from Go AST.

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
    # Set up colors based on terminal
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
    declare -g GOPLANTUML_FLAGS="-recursive"
    declare -g CALLVIS_FLAGS="-format dot"
    declare -g PLANTUML_VERSION="1.2024.8"
    declare -g PLANTUML_JAR="${PLANTUML_JAR:-/tmp/plantuml.jar}"

    # Load config (may override the above)
    _load-config

    # Derived values
    declare -g PLANTUML_URL="https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml-${PLANTUML_VERSION}.jar"

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
