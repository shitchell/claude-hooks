#!/usr/bin/env node
/**
 * generate-diagrams.mjs — Parse JS files and produce deterministic Mermaid
 * diagrams for module dependencies and class hierarchy.
 *
 * Usage:
 *   node tools/generate-diagrams.mjs           # Generate/overwrite .mmd files
 *   node tools/generate-diagrams.mjs --check   # Exit 0 if up-to-date, 2 if stale
 *
 * Exit codes:
 *   0 — Success (or up-to-date in --check mode)
 *   1 — Error
 *   2 — Diagrams are stale (--check mode only)
 *
 * Configuration: diagrams.json in repo root (optional)
 *   See diagrams.sample.json for available options.
 *
 * Output is deterministic (sorted Mermaid text), so simple text comparison
 * is sufficient — no byte-frequency tricks needed.
 *
 * Prerequisites:
 *   npm install --save-dev acorn acorn-walk @mermaid-js/mermaid-cli
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findProjectRoot() {
    try {
        return execSync('git rev-parse --show-toplevel', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    } catch {
        // Fallback: walk up from script location
        return resolve(__dirname, '..');
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROJECT_ROOT = findProjectRoot();

function loadConfig() {
    const configPath = resolve(PROJECT_ROOT, 'diagrams.json');
    if (existsSync(configPath)) {
        try {
            return JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch (err) {
            console.error(`[diagrams] Warning: failed to parse diagrams.json: ${err.message}`);
        }
    }
    return {};
}

const config = loadConfig();

const SCAN_DIRS = (config.scanDirs || ['src']).map(d => resolve(PROJECT_ROOT, d));
const DIAGRAMS_DIR = resolve(PROJECT_ROOT, config.diagramsDir || 'docs/diagrams');
const EXTENSIONS = config.extensions || ['.js'];

// Resolve a "base directory" for relative path computation.
// If all scanDirs share a common parent, use that. Otherwise use PROJECT_ROOT.
function computeBaseDir() {
    if (config.baseDir) return resolve(PROJECT_ROOT, config.baseDir);
    if (SCAN_DIRS.length === 1) return dirname(SCAN_DIRS[0]);
    // Find common prefix of all scan dirs
    const parts = SCAN_DIRS.map(d => relative(PROJECT_ROOT, d).split('/'));
    const common = [];
    outer:
    for (let i = 0; i < parts[0].length; i++) {
        const seg = parts[0][i];
        for (let j = 1; j < parts.length; j++) {
            if (i >= parts[j].length || parts[j][i] !== seg) break outer;
        }
        common.push(seg);
    }
    return common.length > 0
        ? resolve(PROJECT_ROOT, common.join('/'))
        : PROJECT_ROOT;
}

const BASE_DIR = computeBaseDir();

const MODULE_DEP_FILE = resolve(DIAGRAMS_DIR, 'module-dependencies.mmd');
const CLASS_HIERARCHY_FILE = resolve(DIAGRAMS_DIR, 'class-hierarchy.mmd');
const MODULE_DEP_SVG = resolve(DIAGRAMS_DIR, 'module-dependencies.svg');
const CLASS_HIERARCHY_SVG = resolve(DIAGRAMS_DIR, 'class-hierarchy.svg');

const E_SUCCESS = 0;
const E_ERROR = 1;
const E_STALE = 2;

// Colors (only when writing to a terminal)
const isTTY = process.stdout.isTTY;
const C_INFO = isTTY ? '\x1b[34m' : '';
const C_SUCCESS = isTTY ? '\x1b[32m' : '';
const C_WARN = isTTY ? '\x1b[33m' : '';
const C_ERROR = isTTY ? '\x1b[31m' : '';
const C_RESET = isTTY ? '\x1b[0m' : '';

function info(msg) { console.log(`${C_INFO}[diagrams]${C_RESET} ${msg}`); }
function success(msg) { console.log(`${C_SUCCESS}[diagrams]${C_RESET} ${msg}`); }
function warn(msg) { console.error(`${C_WARN}[diagrams]${C_RESET} ${msg}`); }
function error(msg) { console.error(`${C_ERROR}[diagrams]${C_RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Recursively find all files matching configured extensions under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findSourceFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;

    for (const entry of readdirSync(dir)) {
        // Skip common non-source directories
        if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue;
        const full = resolve(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            results.push(...findSourceFiles(full));
        } else if (EXTENSIONS.some(ext => entry.endsWith(ext))) {
            results.push(full);
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// AST parsing & extraction
// ---------------------------------------------------------------------------

/**
 * Parse a single JS file and extract structural information.
 *
 * @param {string} filePath - Absolute path to a .js file
 * @returns {{ imports: Array, classes: Array, exports: Array, functions: Array }}
 */
function parseFile(filePath) {
    const code = readFileSync(filePath, 'utf-8');
    const relPath = relative(BASE_DIR, filePath);

    let ast;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: 2022,
            sourceType: 'module',
            allowAwaitOutsideFunction: true,
        });
    } catch (err) {
        warn(`Failed to parse ${relPath}: ${err.message}`);
        return { imports: [], classes: [], exports: [], functions: [] };
    }

    const imports = [];
    const classes = [];
    const namedExports = [];
    const functions = [];

    walk.simple(ast, {
        ImportDeclaration(node) {
            const source = node.source.value;
            const specifiers = node.specifiers.map(s => {
                if (s.type === 'ImportDefaultSpecifier') {
                    return { imported: 'default', local: s.local.name };
                } else if (s.type === 'ImportNamespaceSpecifier') {
                    return { imported: '*', local: s.local.name };
                } else {
                    return {
                        imported: s.imported.name,
                        local: s.local.name,
                    };
                }
            });
            imports.push({ source, specifiers });
        },

        ClassDeclaration(node) {
            const cls = {
                name: node.id ? node.id.name : '(anonymous)',
                extends: node.superClass ? extractName(node.superClass) : null,
                methods: [],
                properties: [],
            };

            for (const item of node.body.body) {
                // Skip private members (PrivateIdentifier = #name)
                if (item.key && item.key.type === 'PrivateIdentifier') continue;

                if (item.type === 'MethodDefinition') {
                    const name = item.key.name || item.key.value || '(computed)';
                    const prefix = item.static ? 'static ' : '';
                    const kind = item.kind === 'get' ? 'get ' :
                                 item.kind === 'set' ? 'set ' : '';
                    cls.methods.push(`${prefix}${kind}${name}()`);
                } else if (item.type === 'PropertyDefinition') {
                    const name = item.key.name || item.key.value || '(computed)';
                    const prefix = item.static ? 'static ' : '';
                    cls.properties.push(`${prefix}${name}`);
                }
            }

            classes.push(cls);
        },

        ExportNamedDeclaration(node) {
            if (node.declaration) {
                if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
                    namedExports.push(node.declaration.id.name);
                    functions.push(node.declaration.id.name);
                } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
                    namedExports.push(node.declaration.id.name);
                } else if (node.declaration.type === 'VariableDeclaration') {
                    for (const decl of node.declaration.declarations) {
                        if (decl.id.type === 'Identifier') {
                            namedExports.push(decl.id.name);
                        }
                    }
                }
            }
            if (node.specifiers) {
                for (const spec of node.specifiers) {
                    namedExports.push(spec.exported.name);
                }
            }
        },

        ExportDefaultDeclaration(_node) {
            namedExports.push('default');
        },
    });

    return { imports, classes, exports: namedExports, functions };
}

/**
 * Extract a name from an AST node (handles Identifier and MemberExpression).
 */
function extractName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
        return `${extractName(node.object)}.${extractName(node.property)}`;
    }
    return '(unknown)';
}

// ---------------------------------------------------------------------------
// Import path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a relative import path to a BASE_DIR-relative path.
 * Returns null if the import is external (bare specifier).
 *
 * @param {string} importSource - The import source string
 * @param {string} importerRelPath - The importer's path relative to BASE_DIR
 * @returns {string|null}
 */
function resolveImport(importSource, importerRelPath) {
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
        return null;
    }

    const importerDir = dirname(resolve(BASE_DIR, importerRelPath));
    const resolved = resolve(importerDir, importSource);
    return relative(BASE_DIR, resolved);
}

// ---------------------------------------------------------------------------
// Mermaid generation
// ---------------------------------------------------------------------------

function getSubgraph(relPath) {
    return dirname(relPath);
}

function mermaidId(relPath) {
    return relPath.replace(/[/\\.\\-]/g, '_');
}

/**
 * Generate the module dependency Mermaid diagram.
 */
export function generateModuleDependencies(fileMap) {
    const lines = ['graph LR'];

    const subgraphs = new Map();
    const edges = [];

    for (const [relPath, data] of fileMap) {
        const sg = getSubgraph(relPath);
        if (!subgraphs.has(sg)) subgraphs.set(sg, []);
        subgraphs.get(sg).push(relPath);

        for (const imp of data.imports) {
            const target = resolveImport(imp.source, relPath);
            if (target === null) continue;
            if (!fileMap.has(target)) continue;
            edges.push([relPath, target]);
        }
    }

    const sortedSubgraphs = [...subgraphs.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [sgName, members] of sortedSubgraphs) {
        const sortedMembers = [...members].sort();
        lines.push(`    subgraph ${sgName}`);
        for (const m of sortedMembers) {
            const id = mermaidId(m);
            const label = basename(m);
            lines.push(`        ${id}["${label}"]`);
        }
        lines.push('    end');
    }

    const sortedEdges = [...edges].sort((a, b) => {
        const cmp = a[0].localeCompare(b[0]);
        return cmp !== 0 ? cmp : a[1].localeCompare(b[1]);
    });

    const seenEdges = new Set();
    for (const [from, to] of sortedEdges) {
        const key = `${from}->${to}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        lines.push(`    ${mermaidId(from)} --> ${mermaidId(to)}`);
    }

    return lines.join('\n') + '\n';
}

/**
 * Generate the class hierarchy Mermaid diagram.
 */
export function generateClassHierarchy(fileMap) {
    const lines = ['classDiagram'];

    const allClasses = [];
    const exportedFunctions = [];

    for (const [relPath, data] of fileMap) {
        for (const cls of data.classes) {
            allClasses.push({ ...cls, file: relPath });
        }
        for (const fn of data.functions) {
            exportedFunctions.push({ name: fn, file: relPath });
        }
    }

    allClasses.sort((a, b) => a.name.localeCompare(b.name));

    for (const cls of allClasses) {
        lines.push(`    class ${cls.name} {`);

        const sortedProps = [...cls.properties].sort();
        for (const prop of sortedProps) {
            lines.push(`        +${prop}`);
        }

        const sortedMethods = [...cls.methods].sort();
        for (const method of sortedMethods) {
            lines.push(`        +${method}`);
        }

        lines.push('    }');
        lines.push(`    note for ${cls.name} "${cls.file}"`);
    }

    const inheritanceEdges = [];
    for (const cls of allClasses) {
        if (cls.extends) {
            inheritanceEdges.push([cls.extends, cls.name]);
        }
    }
    inheritanceEdges.sort((a, b) => {
        const cmp = a[0].localeCompare(b[0]);
        return cmp !== 0 ? cmp : a[1].localeCompare(b[1]);
    });

    for (const [parent, child] of inheritanceEdges) {
        lines.push(`    ${parent} <|-- ${child}`);
    }

    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Graph data (JSON) for use by validate-architecture.mjs
// ---------------------------------------------------------------------------

/**
 * Build a JSON-serializable graph representation for use by the validator.
 */
export function buildGraphData(fileMap) {
    const modules = {};

    for (const [relPath, data] of fileMap) {
        const imports = [];
        for (const imp of data.imports) {
            const target = resolveImport(imp.source, relPath);
            if (target === null) continue;
            if (!fileMap.has(target)) continue;
            imports.push({
                target,
                specifiers: imp.specifiers.map(s => s.imported),
            });
        }

        modules[relPath] = {
            exports: [...data.exports].sort(),
            imports,
            classes: data.classes.map(c => ({
                name: c.name,
                extends: c.extends,
                methods: [...c.methods].sort(),
                properties: [...c.properties].sort(),
            })),
            functions: [...data.functions].sort(),
        };
    }

    return modules;
}

// ---------------------------------------------------------------------------
// SVG rendering via mermaid-cli
// ---------------------------------------------------------------------------

function renderSvg(inputFile, outputFile) {
    try {
        execFileSync('npx', ['mmdc', '-i', inputFile, '-o', outputFile], {
            cwd: PROJECT_ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60_000,
        });
        return true;
    } catch (err) {
        warn(`Failed to render ${relative(PROJECT_ROOT, outputFile)}: ${err.message}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run diagram generation.
 *
 * @param {object} [options]
 * @param {boolean} [options.check=false] - If true, only check; don't write files
 * @returns {{ moduleDep: string, classHierarchy: string, graphData: object }}
 */
export function generate(options = {}) {
    const { check = false } = options;

    // Discover all source files
    const allFiles = [];
    for (const dir of SCAN_DIRS) {
        allFiles.push(...findSourceFiles(dir));
    }
    allFiles.sort();

    info(`Found ${allFiles.length} source files to parse`);

    // Parse all files
    const fileMap = new Map();
    for (const filePath of allFiles) {
        const relPath = relative(BASE_DIR, filePath);
        const parsed = parseFile(filePath);
        fileMap.set(relPath, parsed);
    }

    // Generate Mermaid outputs
    const moduleDep = generateModuleDependencies(fileMap);
    const classHierarchy = generateClassHierarchy(fileMap);
    const graphData = buildGraphData(fileMap);

    return { moduleDep, classHierarchy, graphData };
}

// Export config for use by validate-architecture.mjs
export { PROJECT_ROOT, BASE_DIR, DIAGRAMS_DIR, MODULE_DEP_FILE, CLASS_HIERARCHY_FILE, config };

function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes('--check');

    if (checkMode) {
        info('Checking if diagrams are up-to-date...');
    } else {
        info('Generating architecture diagrams...');
    }

    // Ensure output directory exists
    mkdirSync(DIAGRAMS_DIR, { recursive: true });

    let result;
    try {
        result = generate({ check: checkMode });
    } catch (err) {
        error(`Generation failed: ${err.message}`);
        process.exit(E_ERROR);
    }

    if (checkMode) {
        let upToDate = true;

        if (existsSync(MODULE_DEP_FILE)) {
            const existing = readFileSync(MODULE_DEP_FILE, 'utf-8');
            if (existing !== result.moduleDep) {
                warn('module-dependencies.mmd is stale');
                upToDate = false;
            }
        } else {
            warn('module-dependencies.mmd does not exist');
            upToDate = false;
        }

        if (existsSync(CLASS_HIERARCHY_FILE)) {
            const existing = readFileSync(CLASS_HIERARCHY_FILE, 'utf-8');
            if (existing !== result.classHierarchy) {
                warn('class-hierarchy.mmd is stale');
                upToDate = false;
            }
        } else {
            warn('class-hierarchy.mmd does not exist');
            upToDate = false;
        }

        if (upToDate) {
            success('Diagrams are up-to-date');
            process.exit(E_SUCCESS);
        } else {
            warn('Diagrams are stale -- regeneration needed');
            process.exit(E_STALE);
        }
    } else {
        writeFileSync(MODULE_DEP_FILE, result.moduleDep);
        info(`Wrote ${relative(PROJECT_ROOT, MODULE_DEP_FILE)}`);

        writeFileSync(CLASS_HIERARCHY_FILE, result.classHierarchy);
        info(`Wrote ${relative(PROJECT_ROOT, CLASS_HIERARCHY_FILE)}`);

        const graphDataFile = resolve(DIAGRAMS_DIR, 'graph-data.json');
        writeFileSync(graphDataFile, JSON.stringify(result.graphData, null, 2) + '\n');
        info(`Wrote ${relative(PROJECT_ROOT, graphDataFile)}`);

        // Render SVGs
        info('Rendering SVGs...');
        const svgResults = [
            [MODULE_DEP_FILE, MODULE_DEP_SVG],
            [CLASS_HIERARCHY_FILE, CLASS_HIERARCHY_SVG],
        ];
        let svgCount = 0;
        for (const [mmdFile, svgFile] of svgResults) {
            if (renderSvg(mmdFile, svgFile)) {
                info(`Wrote ${relative(PROJECT_ROOT, svgFile)}`);
                svgCount++;
            }
        }
        if (svgCount === svgResults.length) {
            success('All diagrams and SVGs generated!');
        } else if (svgCount > 0) {
            warn(`Generated ${svgCount}/${svgResults.length} SVGs (some failed)`);
        } else {
            warn('SVG rendering skipped (mmdc not available or all renders failed)');
            success('All .mmd diagrams generated!');
        }
    }
}

main();
