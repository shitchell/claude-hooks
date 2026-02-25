#!/usr/bin/env node
/**
 * generate-diagrams.mjs -- Parse TypeScript files and produce deterministic
 * Mermaid diagrams for module dependencies and class hierarchy.
 *
 * Usage:
 *   node tools/generate-diagrams.mjs           # Generate/overwrite .mmd files
 *   node tools/generate-diagrams.mjs --check   # Exit 0 if up-to-date, 2 if stale
 *   node tools/generate-diagrams.mjs --force   # Force regeneration
 *   node tools/generate-diagrams.mjs --dump <file>  # Dump parse results for a file
 *
 * Exit codes:
 *   0 -- Success (or up-to-date in --check mode)
 *   1 -- Error
 *   2 -- Diagrams are stale (--check mode only)
 *
 * Configuration: diagrams.json in repo root (optional)
 *
 * Prerequisites:
 *   npm install typescript  (already present in any TS project)
 *   npm install @mermaid-js/mermaid-cli  (optional, for SVG rendering)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import ts from 'typescript';

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
const EXTENSIONS = config.extensions || ['.ts', '.tsx'];
const TSCONFIG_PATH = resolve(PROJECT_ROOT, config.tsconfig || 'tsconfig.json');

/**
 * Compute a base directory for relative path display.
 * If all scanDirs share a common parent, use that. Otherwise use PROJECT_ROOT.
 */
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
    return common.length > 0 ? resolve(PROJECT_ROOT, common.join('/')) : PROJECT_ROOT;
}

const BASE_DIR = computeBaseDir();

const MODULE_DEP_FILE = resolve(DIAGRAMS_DIR, 'module-dependencies.mmd');
const CLASS_HIERARCHY_FILE = resolve(DIAGRAMS_DIR, 'class-hierarchy.mmd');
const GRAPH_DATA_FILE = resolve(DIAGRAMS_DIR, 'graph-data.json');

const E_SUCCESS = 0;
const E_ERROR = 1;
const E_STALE = 2;

// ---------------------------------------------------------------------------
// Color output helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY;
const C = {
    INFO: isTTY ? '\x1b[34m' : '',
    SUCCESS: isTTY ? '\x1b[32m' : '',
    WARN: isTTY ? '\x1b[33m' : '',
    ERROR: isTTY ? '\x1b[31m' : '',
    BOLD: isTTY ? '\x1b[1m' : '',
    DIM: isTTY ? '\x1b[2m' : '',
    RESET: isTTY ? '\x1b[0m' : '',
};

function info(msg) { console.log(`${C.INFO}[diagrams]${C.RESET} ${msg}`); }
function success(msg) { console.log(`${C.SUCCESS}[diagrams]${C.RESET} ${msg}`); }
function warn(msg) { console.error(`${C.WARN}[diagrams]${C.RESET} ${msg}`); }
function error(msg) { console.error(`${C.ERROR}[diagrams]${C.RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** Directories to skip during recursive file discovery. */
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build',
    'playwright-report', 'test-results',
]);

/**
 * Recursively find all files matching configured extensions under a directory.
 * @param {string} dir - Absolute path to search
 * @returns {string[]} Array of absolute file paths
 */
function findSourceFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;

    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
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
 * Parse a single TypeScript file and extract structural information.
 *
 * Uses ts.createSourceFile() for fast per-file parsing (no type checking).
 * Walks the AST to extract classes, interfaces, enums, type aliases,
 * functions, imports, and exports.
 *
 * @param {string} filePath - Absolute path to a .ts/.tsx file
 * @returns {{ imports: Array, classes: Array, interfaces: Array, enums: Array, typeAliases: Array, exports: Array, functions: Array }}
 */
function parseFile(filePath) {
    const code = readFileSync(filePath, 'utf-8');
    const relPath = relative(BASE_DIR, filePath);
    const isTsx = filePath.endsWith('.tsx');

    let sourceFile;
    try {
        sourceFile = ts.createSourceFile(
            filePath,
            code,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ true,
            isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
    } catch (err) {
        warn(`Failed to parse ${relPath}: ${err.message}`);
        return { imports: [], classes: [], interfaces: [], enums: [], typeAliases: [], exports: [], functions: [] };
    }

    const imports = [];
    const classes = [];
    const interfaces = [];
    const enums = [];
    const typeAliases = [];
    const namedExports = [];
    const functions = [];

    function getModifiers(node) {
        const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (!mods) return { isExported: false, isAbstract: false, isStatic: false, isReadonly: false, visibility: 'public' };
        return {
            isExported: mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
            isAbstract: mods.some(m => m.kind === ts.SyntaxKind.AbstractKeyword),
            isStatic: mods.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
            isReadonly: mods.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword),
            visibility: mods.some(m => m.kind === ts.SyntaxKind.PrivateKeyword) ? 'private'
                : mods.some(m => m.kind === ts.SyntaxKind.ProtectedKeyword) ? 'protected'
                : 'public',
        };
    }

    function getTypeName(typeNode) {
        if (!typeNode) return null;
        // Use getText() on the full node to include generic type arguments
        // e.g., Promise<string> instead of just Promise
        return typeNode.getText(sourceFile);
    }

    function extractMembers(node) {
        const methods = [];
        const properties = [];

        for (const member of node.members || []) {
            const mods = getModifiers(member);
            // Skip private members for diagram purposes
            if (mods.visibility === 'private') continue;

            const name = member.name ? member.name.getText(sourceFile) : null;
            if (!name) continue;

            if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
                const prefix = [];
                if (mods.isStatic) prefix.push('static');
                if (mods.isAbstract) prefix.push('abstract');
                const returnType = getTypeName(member.type);
                const params = member.parameters
                    ? member.parameters.map(p => {
                        const pName = p.name.getText(sourceFile);
                        const pType = getTypeName(p.type);
                        return pType ? `${pName}: ${pType}` : pName;
                    }).join(', ')
                    : '';
                const sig = `${prefix.join(' ')}${prefix.length ? ' ' : ''}${name}(${params})${returnType ? ': ' + returnType : ''}`;
                methods.push(sig.trim());
            } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
                const prefix = [];
                if (mods.isStatic) prefix.push('static');
                if (mods.isReadonly) prefix.push('readonly');
                const propType = getTypeName(member.type);
                const sig = `${prefix.join(' ')}${prefix.length ? ' ' : ''}${name}${propType ? ': ' + propType : ''}`;
                properties.push(sig.trim());
            } else if (ts.isGetAccessorDeclaration(member)) {
                const returnType = getTypeName(member.type);
                methods.push(`get ${name}()${returnType ? ': ' + returnType : ''}`);
            } else if (ts.isSetAccessorDeclaration(member)) {
                methods.push(`set ${name}()`);
            }
        }

        return { methods, properties };
    }

    function visit(node) {
        // Import declarations
        if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
            const source = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, '');
            const specifiers = [];
            if (node.importClause) {
                if (node.importClause.name) {
                    specifiers.push({ imported: 'default', local: node.importClause.name.getText(sourceFile) });
                }
                if (node.importClause.namedBindings) {
                    if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                        specifiers.push({ imported: '*', local: node.importClause.namedBindings.name.getText(sourceFile) });
                    } else if (ts.isNamedImports(node.importClause.namedBindings)) {
                        for (const el of node.importClause.namedBindings.elements) {
                            specifiers.push({
                                imported: el.propertyName ? el.propertyName.getText(sourceFile) : el.name.getText(sourceFile),
                                local: el.name.getText(sourceFile),
                            });
                        }
                    }
                }
            }
            imports.push({ source, specifiers });
        }

        // Class declarations
        if (ts.isClassDeclaration(node)) {
            const mods = getModifiers(node);
            const name = node.name ? node.name.getText(sourceFile) : '(anonymous)';
            const extendsClause = null;
            const implementsList = [];

            let resolvedExtends = extendsClause;
            if (node.heritageClauses) {
                for (const clause of node.heritageClauses) {
                    for (const type of clause.types) {
                        const typeName = type.expression.getText(sourceFile);
                        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                            resolvedExtends = typeName;
                        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                            implementsList.push(typeName);
                        }
                    }
                }
            }

            const { methods, properties } = extractMembers(node);

            classes.push({
                name,
                extends: resolvedExtends,
                implements: implementsList,
                methods,
                properties,
                isAbstract: mods.isAbstract,
            });

            if (mods.isExported) namedExports.push(name);
        }

        // Interface declarations
        if (ts.isInterfaceDeclaration(node)) {
            const mods = getModifiers(node);
            const name = node.name.getText(sourceFile);
            const extendsList = [];

            if (node.heritageClauses) {
                for (const clause of node.heritageClauses) {
                    for (const type of clause.types) {
                        extendsList.push(type.expression.getText(sourceFile));
                    }
                }
            }

            const { methods, properties } = extractMembers(node);

            interfaces.push({
                name,
                extends: extendsList,
                methods,
                properties,
            });

            if (mods.isExported) namedExports.push(name);
        }

        // Enum declarations
        if (ts.isEnumDeclaration(node)) {
            const mods = getModifiers(node);
            const name = node.name.getText(sourceFile);
            const members = node.members.map(m => m.name.getText(sourceFile));
            enums.push({ name, members });
            if (mods.isExported) namedExports.push(name);
        }

        // Type alias declarations
        if (ts.isTypeAliasDeclaration(node)) {
            const mods = getModifiers(node);
            const name = node.name.getText(sourceFile);
            typeAliases.push({ name, type: node.type.getText(sourceFile) });
            if (mods.isExported) namedExports.push(name);
        }

        // Function declarations
        if (ts.isFunctionDeclaration(node) && node.name) {
            const mods = getModifiers(node);
            const name = node.name.getText(sourceFile);
            functions.push(name);
            if (mods.isExported) namedExports.push(name);
        }

        // Export declarations (re-exports)
        if (ts.isExportDeclaration(node)) {
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                for (const el of node.exportClause.elements) {
                    namedExports.push(el.name.getText(sourceFile));
                }
            }
        }

        // Variable statement exports (export const foo = ...)
        if (ts.isVariableStatement(node)) {
            const mods = getModifiers(node);
            if (mods.isExported) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        namedExports.push(decl.name.getText(sourceFile));
                    }
                }
            }
        }

        // Export default
        if (ts.isExportAssignment(node)) {
            namedExports.push('default');
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    return { imports, classes, interfaces, enums, typeAliases, exports: namedExports, functions };
}

// ---------------------------------------------------------------------------
// Import path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a relative import path to a BASE_DIR-relative path.
 * Returns null if the import is a bare specifier (external package or alias).
 *
 * For imports without file extensions, tries appending .ts, .tsx, and
 * checking for index.ts / index.tsx.
 *
 * @param {string} importSource - The import source string (e.g., './types', '../core/Selector')
 * @param {string} importerRelPath - The importer's path relative to BASE_DIR
 * @returns {string|null} - BASE_DIR-relative path, or null for external/alias imports
 */
function resolveImport(importSource, importerRelPath) {
    // Skip bare specifiers: anything that doesn't start with . or ..
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
        return null;
    }

    const importerDir = dirname(resolve(BASE_DIR, importerRelPath));
    const resolved = resolve(importerDir, importSource);
    const relResolved = relative(BASE_DIR, resolved);

    // If the exact path (with extension) exists in the filesystem, use it
    if (existsSync(resolved) && statSync(resolved).isFile()) {
        return relResolved;
    }

    // Try appending TypeScript extensions
    for (const ext of EXTENSIONS) {
        const withExt = resolved + ext;
        if (existsSync(withExt)) {
            return relative(BASE_DIR, withExt);
        }
    }

    // Try index files (for directory imports)
    for (const ext of EXTENSIONS) {
        const indexFile = resolve(resolved, 'index' + ext);
        if (existsSync(indexFile)) {
            return relative(BASE_DIR, indexFile);
        }
    }

    // Could not resolve — return the best guess (with .ts appended)
    // This ensures we don't lose edges for files that might be in the fileMap
    return relResolved + '.ts';
}

// ---------------------------------------------------------------------------
// Mermaid helpers
// ---------------------------------------------------------------------------

/**
 * Convert a file path to a valid Mermaid node ID.
 * Replaces /, ., -, @ with underscores.
 *
 * @param {string} relPath - A file path (relative to BASE_DIR)
 * @returns {string}
 */
function mermaidId(relPath) {
    return relPath.replace(/[/.\-@]/g, '_');
}

/**
 * Get the subgraph name (directory) for a given file path.
 * @param {string} relPath
 * @returns {string}
 */
function getSubgraph(relPath) {
    return dirname(relPath);
}

// ---------------------------------------------------------------------------
// Mermaid diagram generation
// ---------------------------------------------------------------------------

/**
 * Generate a module dependency Mermaid diagram (graph LR).
 * Files are grouped by directory into subgraphs.
 * Edges represent imports between files within the scanned fileMap.
 * Everything is sorted for deterministic output.
 *
 * @param {Map<string, object>} fileMap - Map of relPath -> parseFile() results
 * @returns {string} - Mermaid diagram text
 */
function generateModuleDependencies(fileMap) {
    const lines = ['graph LR'];

    // Group files by directory
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

    // Emit subgraphs sorted by name
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

    // Emit edges sorted and deduplicated
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
 * Generate a class hierarchy Mermaid diagram (classDiagram).
 * Shows interfaces, abstract classes, concrete classes, enums,
 * their members, and inheritance/implementation relationships.
 *
 * @param {Map<string, object>} fileMap - Map of relPath -> parseFile() results
 * @returns {string} - Mermaid classDiagram text
 */
/**
 * Sanitize a type signature for Mermaid classDiagram syntax.
 * - Replaces <T> with ~T~ (Mermaid generic syntax)
 * - Replaces inline object types { ... } with Object (Mermaid can't parse braces in members)
 */
function sanitizeMermaid(sig) {
    // First, replace inline object types like { width: number; height: number } with Object
    let result = sig.replace(/\{[^}]*\}/g, 'Object');
    // Then replace angle brackets with tildes for generics
    result = result.replace(/</g, '~').replace(/>/g, '~');
    return result;
}

function generateClassHierarchy(fileMap) {
    const lines = ['classDiagram'];

    // Collect all types across all files
    const allInterfaces = [];
    const allClasses = [];
    const allEnums = [];

    for (const [relPath, data] of fileMap) {
        for (const iface of data.interfaces) {
            allInterfaces.push({ ...iface, file: relPath });
        }
        for (const cls of data.classes) {
            allClasses.push({ ...cls, file: relPath });
        }
        for (const enm of data.enums) {
            allEnums.push({ ...enm, file: relPath });
        }
    }

    // Sort each collection by name for determinism
    allInterfaces.sort((a, b) => a.name.localeCompare(b.name));
    allClasses.sort((a, b) => a.name.localeCompare(b.name));
    allEnums.sort((a, b) => a.name.localeCompare(b.name));

    // Emit interfaces
    for (const iface of allInterfaces) {
        lines.push(`    class ${iface.name} {`);
        lines.push(`        <<interface>>`);

        const sortedProps = [...iface.properties].sort();
        for (const prop of sortedProps) {
            lines.push(`        +${sanitizeMermaid(prop)}`);
        }

        const sortedMethods = [...iface.methods].sort();
        for (const method of sortedMethods) {
            lines.push(`        +${sanitizeMermaid(method)}`);
        }

        lines.push('    }');
        lines.push(`    note for ${iface.name} "${iface.file}"`);
    }

    // Emit classes
    for (const cls of allClasses) {
        lines.push(`    class ${cls.name} {`);
        if (cls.isAbstract) {
            lines.push(`        <<abstract>>`);
        }

        const sortedProps = [...cls.properties].sort();
        for (const prop of sortedProps) {
            lines.push(`        +${sanitizeMermaid(prop)}`);
        }

        const sortedMethods = [...cls.methods].sort();
        for (const method of sortedMethods) {
            lines.push(`        +${sanitizeMermaid(method)}`);
        }

        lines.push('    }');
        lines.push(`    note for ${cls.name} "${cls.file}"`);
    }

    // Emit enums
    for (const enm of allEnums) {
        lines.push(`    class ${enm.name} {`);
        lines.push(`        <<enumeration>>`);

        const sortedMembers = [...enm.members].sort();
        for (const member of sortedMembers) {
            lines.push(`        ${member}`);
        }

        lines.push('    }');
        lines.push(`    note for ${enm.name} "${enm.file}"`);
    }

    // Collect and emit inheritance edges
    const inheritanceEdges = [];

    // Interface extends interface
    for (const iface of allInterfaces) {
        for (const ext of iface.extends) {
            inheritanceEdges.push({ parent: ext, child: iface.name, type: 'extends' });
        }
    }

    // Class extends class
    for (const cls of allClasses) {
        if (cls.extends) {
            inheritanceEdges.push({ parent: cls.extends, child: cls.name, type: 'extends' });
        }
        // Class implements interface
        for (const impl of cls.implements) {
            inheritanceEdges.push({ parent: impl, child: cls.name, type: 'implements' });
        }
    }

    // Sort edges for determinism
    inheritanceEdges.sort((a, b) => {
        const cmp = a.parent.localeCompare(b.parent);
        if (cmp !== 0) return cmp;
        const cmp2 = a.child.localeCompare(b.child);
        if (cmp2 !== 0) return cmp2;
        return a.type.localeCompare(b.type);
    });

    for (const edge of inheritanceEdges) {
        if (edge.type === 'implements') {
            lines.push(`    ${edge.parent} <|.. ${edge.child}`);
        } else {
            lines.push(`    ${edge.parent} <|-- ${edge.child}`);
        }
    }

    return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Graph data (JSON) for use by validate-architecture.mjs
// ---------------------------------------------------------------------------

/**
 * Build a JSON-serializable graph representation for use by the validator.
 *
 * @param {Map<string, object>} fileMap - Map of relPath -> parseFile() results
 * @returns {object} - Modules keyed by relPath
 */
function buildGraphData(fileMap) {
    const modules = {};

    for (const [relPath, data] of fileMap) {
        const imports = [];
        for (const imp of data.imports) {
            const target = resolveImport(imp.source, relPath);
            imports.push({
                source: imp.source,
                target,
                specifiers: imp.specifiers.map(s => s.imported).sort(),
            });
        }
        // Sort imports by source for determinism
        imports.sort((a, b) => a.source.localeCompare(b.source));

        modules[relPath] = {
            exports: [...data.exports].sort(),
            imports,
            classes: data.classes.map(c => ({
                name: c.name,
                extends: c.extends,
                implements: [...c.implements],
                methods: [...c.methods].sort(),
                properties: [...c.properties].sort(),
                isAbstract: c.isAbstract,
            })),
            interfaces: data.interfaces.map(i => ({
                name: i.name,
                extends: [...i.extends],
                methods: [...i.methods].sort(),
                properties: [...i.properties].sort(),
            })),
            enums: data.enums.map(e => ({
                name: e.name,
                members: [...e.members],
            })),
            typeAliases: data.typeAliases.map(t => ({
                name: t.name,
                type: t.type,
            })),
            functions: [...data.functions].sort(),
        };
    }

    return modules;
}

// ---------------------------------------------------------------------------
// SVG rendering via mermaid-cli
// ---------------------------------------------------------------------------

/**
 * Attempt to render a .mmd file to SVG via mermaid-cli (mmdc).
 *
 * @param {string} inputFile - Absolute path to .mmd file
 * @param {string} outputFile - Absolute path for .svg output
 * @returns {boolean} - true if rendering succeeded
 */
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
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Discover files, parse all, and generate all three outputs.
 *
 * @param {object} [options]
 * @param {boolean} [options.check=false] - If true, only generate in memory (no writes)
 * @returns {{ moduleDep: string, classHierarchy: string, graphData: object }}
 */
function generate(options = {}) {
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

    // Generate outputs
    const moduleDep = generateModuleDependencies(fileMap);
    const classHierarchy = generateClassHierarchy(fileMap);
    const graphData = buildGraphData(fileMap);

    return { moduleDep, classHierarchy, graphData };
}

// ---------------------------------------------------------------------------
// Exports (for validate-architecture.mjs to import)
// ---------------------------------------------------------------------------

export {
    PROJECT_ROOT,
    BASE_DIR,
    DIAGRAMS_DIR,
    MODULE_DEP_FILE,
    CLASS_HIERARCHY_FILE,
    GRAPH_DATA_FILE,
    TSCONFIG_PATH,
    SCAN_DIRS,
    EXTENSIONS,
    config,
    E_SUCCESS,
    E_ERROR,
    E_STALE,
    C,
    info,
    success,
    warn,
    error,
    findSourceFiles,
    parseFile,
    resolveImport,
    mermaidId,
    generateModuleDependencies,
    generateClassHierarchy,
    buildGraphData,
    generate,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MODULE_DEP_SVG = resolve(DIAGRAMS_DIR, 'module-dependencies.svg');
const CLASS_HIERARCHY_SVG = resolve(DIAGRAMS_DIR, 'class-hierarchy.svg');

function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes('--check');
    const forceMode = args.includes('--force');
    const dumpMode = args.includes('--dump');

    // --dump: debug mode to dump parse results for a single file
    if (dumpMode) {
        const dumpIndex = args.indexOf('--dump');
        const targetFile = args[dumpIndex + 1];
        if (!targetFile) {
            error('--dump requires a file path');
            process.exit(E_ERROR);
        }
        const absPath = resolve(process.cwd(), targetFile);
        if (!existsSync(absPath)) {
            error(`File not found: ${absPath}`);
            process.exit(E_ERROR);
        }
        const result = parseFile(absPath);
        console.log(JSON.stringify(result, null, 2));
        process.exit(E_SUCCESS);
    }

    info(checkMode ? 'Checking if diagrams are up-to-date...' : 'Generating architecture diagrams...');

    // Ensure output directory exists
    mkdirSync(DIAGRAMS_DIR, { recursive: true });

    // Generate all outputs
    let result;
    try {
        result = generate({ check: checkMode });
    } catch (err) {
        error(`Generation failed: ${err.message}`);
        process.exit(E_ERROR);
    }

    const graphDataJson = JSON.stringify(result.graphData, null, 2) + '\n';

    if (checkMode) {
        // --check mode: compare generated output against existing files
        let upToDate = true;

        const checks = [
            [MODULE_DEP_FILE, result.moduleDep, 'module-dependencies.mmd'],
            [CLASS_HIERARCHY_FILE, result.classHierarchy, 'class-hierarchy.mmd'],
            [GRAPH_DATA_FILE, graphDataJson, 'graph-data.json'],
        ];

        for (const [filePath, content, label] of checks) {
            if (existsSync(filePath)) {
                const existing = readFileSync(filePath, 'utf-8');
                if (existing !== content) {
                    warn(`${label} is stale`);
                    upToDate = false;
                }
            } else {
                warn(`${label} does not exist`);
                upToDate = false;
            }
        }

        if (upToDate) {
            success('Diagrams are up-to-date');
            process.exit(E_SUCCESS);
        } else {
            warn('Diagrams are stale -- regeneration needed');
            process.exit(E_STALE);
        }
    } else {
        // Normal / --force mode: write files
        writeFileSync(MODULE_DEP_FILE, result.moduleDep);
        info(`Wrote ${relative(PROJECT_ROOT, MODULE_DEP_FILE)}`);

        writeFileSync(CLASS_HIERARCHY_FILE, result.classHierarchy);
        info(`Wrote ${relative(PROJECT_ROOT, CLASS_HIERARCHY_FILE)}`);

        writeFileSync(GRAPH_DATA_FILE, graphDataJson);
        info(`Wrote ${relative(PROJECT_ROOT, GRAPH_DATA_FILE)}`);

        // Attempt SVG rendering via mermaid-cli
        info('Rendering SVGs...');
        const svgPairs = [
            [MODULE_DEP_FILE, MODULE_DEP_SVG],
            [CLASS_HIERARCHY_FILE, CLASS_HIERARCHY_SVG],
        ];
        let svgCount = 0;
        for (const [mmdFile, svgFile] of svgPairs) {
            if (renderSvg(mmdFile, svgFile)) {
                info(`Wrote ${relative(PROJECT_ROOT, svgFile)}`);
                svgCount++;
            }
        }
        if (svgCount === svgPairs.length) {
            success('All diagrams and SVGs generated!');
        } else if (svgCount > 0) {
            warn(`Generated ${svgCount}/${svgPairs.length} SVGs (some failed)`);
        } else {
            warn('SVG rendering skipped (mmdc not available or all renders failed)');
            success('All .mmd diagrams generated!');
        }
    }
}

// Only run main() when executed directly, not when imported as a module
const isDirectRun = process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
    main();
}
