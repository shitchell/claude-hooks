#!/usr/bin/env node
/**
 * validate-architecture.mjs -- Validate that architecture diagrams are
 * up-to-date and that the review file is staged when structural changes
 * are detected.
 *
 * Uses the TypeScript compiler API for connected-type analysis, matching
 * the Go variant's gopls-powered reference finding.
 *
 * Usage:
 *   node tools/validate-architecture.mjs                       # Full validation
 *   node tools/validate-architecture.mjs --test-fingerprints   # Test fingerprinting
 *   node tools/validate-architecture.mjs --test-connections T  # Test connected-type analysis for type T
 *
 * Exit codes:
 *   0 -- Diagrams up-to-date, or changed AND review file staged
 *   1 -- Diagrams changed but review file NOT staged (commit blocked)
 *   2 -- Error during execution
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import {
    generate,
    PROJECT_ROOT,
    DIAGRAMS_DIR,
    MODULE_DEP_FILE,
    CLASS_HIERARCHY_FILE,
    GRAPH_DATA_FILE,
    TSCONFIG_PATH,
    config,
    C,
    info, success, warn, error,
} from './generate-diagrams.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACKING_FILE = resolve(DIAGRAMS_DIR, '.tracking');
const REVIEW_FILE = resolve(PROJECT_ROOT, config.reviewFile || 'docs/ARCHITECTURE.md');
const ENTRY_PATTERNS = (config.entryPatterns || ['index\\.ts$']).map(p => new RegExp(p));

// ---------------------------------------------------------------------------
// Fingerprinting (matches Go's .tracking file format)
// ---------------------------------------------------------------------------

/**
 * Compute SHA256 hash of a string.
 * @param {string} content
 * @returns {string} hex digest
 */
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA256 fingerprints for the current .mmd diagram files.
 * @returns {{ MODULE_DEP_SHA256?: string, CLASS_HIERARCHY_SHA256?: string }}
 */
function computeFingerprints() {
    const fingerprints = {};
    if (existsSync(MODULE_DEP_FILE)) {
        fingerprints.MODULE_DEP_SHA256 = sha256(readFileSync(MODULE_DEP_FILE, 'utf-8'));
    }
    if (existsSync(CLASS_HIERARCHY_FILE)) {
        fingerprints.CLASS_HIERARCHY_SHA256 = sha256(readFileSync(CLASS_HIERARCHY_FILE, 'utf-8'));
    }
    return fingerprints;
}

/**
 * Read the .tracking file and return its key-value pairs.
 * The file is bash-sourceable (KEY="value" lines).
 * @returns {{ MODULE_DEP_SHA256: string, CLASS_HIERARCHY_SHA256: string, VERIFIED_AT: string }}
 */
function readTracking() {
    const tracking = {
        MODULE_DEP_SHA256: '',
        CLASS_HIERARCHY_SHA256: '',
        VERIFIED_AT: '',
    };
    if (existsSync(TRACKING_FILE)) {
        const content = readFileSync(TRACKING_FILE, 'utf-8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const eqIdx = trimmed.indexOf('=');
            const key = trimmed.slice(0, eqIdx);
            const val = trimmed.slice(eqIdx + 1).replace(/^"|"$/g, '');
            if (key in tracking) tracking[key] = val;
        }
    }
    return tracking;
}

/**
 * Write fingerprints to the .tracking file.
 * Format matches Go's bash-sourceable tracking file.
 * @param {{ MODULE_DEP_SHA256?: string, CLASS_HIERARCHY_SHA256?: string }} fingerprints
 */
function writeTracking(fingerprints) {
    const content = [
        '# Auto-generated tracking file for documentation diagrams',
        '# Maps source fingerprints to verified architecture state',
        `MODULE_DEP_SHA256="${fingerprints.MODULE_DEP_SHA256 || ''}"`,
        `CLASS_HIERARCHY_SHA256="${fingerprints.CLASS_HIERARCHY_SHA256 || ''}"`,
        `VERIFIED_AT="${new Date().toISOString()}"`,
        '',
    ].join('\n');
    writeFileSync(TRACKING_FILE, content);
}

/**
 * Check if current diagram fingerprints match the tracking file.
 * @returns {boolean} true if fingerprints match (architecture is up-to-date)
 */
function sourcesMatchTracking() {
    const tracked = readTracking();
    const current = computeFingerprints();
    return tracked.MODULE_DEP_SHA256 === (current.MODULE_DEP_SHA256 || '') &&
           tracked.CLASS_HIERARCHY_SHA256 === (current.CLASS_HIERARCHY_SHA256 || '');
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Check if a file is staged in the git index.
 * @param {string} filePath - Path relative to repo root
 * @returns {boolean}
 */
function isStaged(filePath) {
    try {
        const staged = execSync('git diff --cached --name-only', {
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
        });
        return staged.split('\n').some(f => f.trim() === filePath);
    } catch {
        return false;
    }
}

/**
 * Get the content of a file as it exists in the last commit (HEAD).
 * @param {string} relPath - Path relative to repo root
 * @returns {string|null} File content, or null if not found
 */
function getCommittedContent(relPath) {
    try {
        return execSync(`git show HEAD:${relPath}`, {
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

/**
 * Compare old and new graph data to find structural changes.
 *
 * Detects added/removed modules and per-module changes including:
 * classes, interfaces, enums, functions, imports, exports.
 *
 * @param {object} oldGraph - Previous graph-data.json content
 * @param {object} newGraph - Current graph-data.json content
 * @returns {{ added: string[], removed: string[], modified: Map<string, object[]> }}
 */
function diffGraphs(oldGraph, newGraph) {
    const oldModules = new Set(Object.keys(oldGraph));
    const newModules = new Set(Object.keys(newGraph));

    const added = [...newModules].filter(m => !oldModules.has(m)).sort();
    const removed = [...oldModules].filter(m => !newModules.has(m)).sort();

    const modified = new Map();
    for (const mod of newModules) {
        if (!oldModules.has(mod)) continue;

        const oldMod = oldGraph[mod];
        const newMod = newGraph[mod];
        const changes = [];

        // Exports
        const addedExports = newMod.exports.filter(e => !oldMod.exports.includes(e));
        const removedExports = oldMod.exports.filter(e => !newMod.exports.includes(e));
        if (addedExports.length > 0) changes.push({ type: 'added_exports', items: addedExports });
        if (removedExports.length > 0) changes.push({ type: 'removed_exports', items: removedExports });

        // Classes
        const oldClassNames = new Set((oldMod.classes || []).map(c => c.name));
        const newClassNames = new Set((newMod.classes || []).map(c => c.name));

        for (const cls of (newMod.classes || [])) {
            if (!oldClassNames.has(cls.name)) {
                changes.push({ type: 'added_class', name: cls.name });
                continue;
            }
            const oldCls = oldMod.classes.find(c => c.name === cls.name);
            const addedMethods = cls.methods.filter(m => !oldCls.methods.includes(m));
            const removedMethods = oldCls.methods.filter(m => !cls.methods.includes(m));
            const addedProps = cls.properties.filter(p => !oldCls.properties.includes(p));
            const removedProps = oldCls.properties.filter(p => !cls.properties.includes(p));

            if (addedMethods.length > 0) changes.push({ type: 'added_methods', class: cls.name, items: addedMethods });
            if (removedMethods.length > 0) changes.push({ type: 'removed_methods', class: cls.name, items: removedMethods });
            if (addedProps.length > 0) changes.push({ type: 'added_properties', class: cls.name, items: addedProps });
            if (removedProps.length > 0) changes.push({ type: 'removed_properties', class: cls.name, items: removedProps });

            if (cls.extends !== oldCls.extends) {
                changes.push({ type: 'changed_extends', class: cls.name, from: oldCls.extends, to: cls.extends });
            }
        }

        for (const oldCls of (oldMod.classes || [])) {
            if (!newClassNames.has(oldCls.name)) {
                changes.push({ type: 'removed_class', name: oldCls.name });
            }
        }

        // Interfaces (TS-specific)
        const oldIfaceNames = new Set((oldMod.interfaces || []).map(i => i.name));
        const newIfaceNames = new Set((newMod.interfaces || []).map(i => i.name));

        for (const iface of (newMod.interfaces || [])) {
            if (!oldIfaceNames.has(iface.name)) {
                changes.push({ type: 'added_interface', name: iface.name });
                continue;
            }
            const oldIface = oldMod.interfaces.find(i => i.name === iface.name);
            const addedMethods = iface.methods.filter(m => !oldIface.methods.includes(m));
            const removedMethods = oldIface.methods.filter(m => !iface.methods.includes(m));
            const addedProps = iface.properties.filter(p => !oldIface.properties.includes(p));
            const removedProps = oldIface.properties.filter(p => !iface.properties.includes(p));

            if (addedMethods.length > 0) changes.push({ type: 'added_interface_methods', interface: iface.name, items: addedMethods });
            if (removedMethods.length > 0) changes.push({ type: 'removed_interface_methods', interface: iface.name, items: removedMethods });
            if (addedProps.length > 0) changes.push({ type: 'added_interface_properties', interface: iface.name, items: addedProps });
            if (removedProps.length > 0) changes.push({ type: 'removed_interface_properties', interface: iface.name, items: removedProps });
        }

        for (const oldIface of (oldMod.interfaces || [])) {
            if (!newIfaceNames.has(oldIface.name)) {
                changes.push({ type: 'removed_interface', name: oldIface.name });
            }
        }

        // Enums (TS-specific)
        const oldEnumNames = new Set((oldMod.enums || []).map(e => e.name));
        const newEnumNames = new Set((newMod.enums || []).map(e => e.name));

        for (const enm of (newMod.enums || [])) {
            if (!oldEnumNames.has(enm.name)) {
                changes.push({ type: 'added_enum', name: enm.name });
            }
        }
        for (const oldEnm of (oldMod.enums || [])) {
            if (!newEnumNames.has(oldEnm.name)) {
                changes.push({ type: 'removed_enum', name: oldEnm.name });
            }
        }

        // Functions
        const addedFunctions = (newMod.functions || []).filter(f => !(oldMod.functions || []).includes(f));
        const removedFunctions = (oldMod.functions || []).filter(f => !(newMod.functions || []).includes(f));
        if (addedFunctions.length > 0) changes.push({ type: 'added_functions', items: addedFunctions });
        if (removedFunctions.length > 0) changes.push({ type: 'removed_functions', items: removedFunctions });

        // Imports
        const oldImportTargets = new Set((oldMod.imports || []).map(i => i.target));
        const newImportTargets = new Set((newMod.imports || []).map(i => i.target));
        const addedImports = [...newImportTargets].filter(t => !oldImportTargets.has(t));
        const removedImports = [...oldImportTargets].filter(t => !newImportTargets.has(t));
        if (addedImports.length > 0) changes.push({ type: 'added_imports', items: addedImports });
        if (removedImports.length > 0) changes.push({ type: 'removed_imports', items: removedImports });

        if (changes.length > 0) {
            modified.set(mod, changes);
        }
    }

    return { added, removed, modified };
}

/**
 * Find all modules that import a given module.
 * @param {string} targetModule - Module path to search for
 * @param {object} graph - Graph data
 * @returns {string[]} Consumer descriptions
 */
function findConsumers(targetModule, graph) {
    const consumers = [];
    for (const [mod, data] of Object.entries(graph)) {
        if (mod === targetModule) continue;
        for (const imp of data.imports) {
            if (imp.target === targetModule) {
                const specifiers = imp.specifiers.join(', ');
                consumers.push(`${mod} (imports ${specifiers})`);
                break;
            }
        }
    }
    return consumers.sort();
}

/**
 * Find dead-end modules (exported but never imported by anything).
 * Excludes modules matching entryPatterns (e.g., config.ts, index.ts).
 * @param {object} graph - Graph data
 * @returns {string[]} Dead-end module paths
 */
function findDeadEnds(graph) {
    const allModules = Object.keys(graph);
    const importedModules = new Set();

    for (const data of Object.values(graph)) {
        for (const imp of data.imports) {
            if (imp.target) importedModules.add(imp.target);
        }
    }

    const deadEnds = [];
    for (const mod of allModules) {
        if (importedModules.has(mod)) continue;
        // Skip entry point files
        if (ENTRY_PATTERNS.some(p => p.test(mod))) continue;
        if (graph[mod].exports.length > 0) {
            deadEnds.push(mod);
        }
    }

    return deadEnds.sort();
}

/**
 * Find orphan modules (no imports and no exports).
 * @param {object} graph - Graph data
 * @returns {string[]} Orphan module paths
 */
function findOrphans(graph) {
    const orphans = [];
    for (const [mod, data] of Object.entries(graph)) {
        if (data.imports.length === 0 && data.exports.length === 0) {
            orphans.push(mod);
        }
    }
    return orphans.sort();
}

// ---------------------------------------------------------------------------
// Connected-type analysis (TS compiler API -- matches Go's gopls analysis)
// ---------------------------------------------------------------------------

/**
 * Create a TypeScript program from the project's tsconfig.
 * This gives us full type information for cross-file reference analysis.
 * @returns {ts.Program|null}
 */
function createTSProgram() {
    const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
    if (configFile.error) {
        warn(`Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`);
        return null;
    }

    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, PROJECT_ROOT);
    if (parsed.errors.length > 0) {
        warn(`tsconfig parse errors: ${parsed.errors.length}`);
    }

    return ts.createProgram(parsed.fileNames, parsed.options);
}

/**
 * Find the enclosing class/interface and method for a given AST node.
 * Walks up the AST to find the nearest containing context.
 *
 * @param {ts.Node} node
 * @returns {{ typeName: string|null, methodName: string|null, functionName: string|null }}
 */
function findEnclosingContext(node) {
    let current = node.parent;
    let methodName = null;
    let typeName = null;
    let functionName = null;

    while (current) {
        if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
            if (!methodName && current.name) {
                try { methodName = current.name.getText(); } catch { /* skip */ }
            }
        } else if (ts.isConstructorDeclaration(current)) {
            if (!methodName) {
                methodName = 'constructor';
            }
        } else if (ts.isFunctionDeclaration(current) && current.name) {
            if (!functionName) {
                try { functionName = current.name.getText(); } catch { /* skip */ }
            }
        } else if (ts.isClassDeclaration(current) && current.name) {
            try { typeName = current.name.getText(); } catch { /* skip */ }
            break;
        } else if (ts.isInterfaceDeclaration(current) && current.name) {
            try { typeName = current.name.getText(); } catch { /* skip */ }
            break;
        }
        current = current.parent;
    }

    return { typeName, methodName, functionName };
}

/**
 * Categorize how a type is referenced at a specific AST node.
 * Matches Go's categories: creates, param, returns, field, extends, uses.
 *
 * @param {ts.Node} node - The identifier node referencing the type
 * @param {ts.Node} parent - The parent of the identifier node
 * @returns {string} Relationship category
 */
function categorizeReference(node, parent) {
    // Guard against missing parent
    if (!parent) return 'uses';

    // new Foo() -- creates
    if (ts.isNewExpression(parent) && parent.expression === node) {
        return 'creates';
    }

    // Type reference in different contexts
    if (ts.isTypeReferenceNode(parent)) {
        const grandparent = parent.parent;
        if (!grandparent) return 'uses';

        // Parameter type: (param: Foo)
        if (ts.isParameter(grandparent)) return 'param';

        // Return type: (): Foo
        if (ts.isFunctionDeclaration(grandparent) || ts.isMethodDeclaration(grandparent) ||
            ts.isArrowFunction(grandparent) || ts.isFunctionExpression(grandparent) ||
            ts.isGetAccessorDeclaration(grandparent) || ts.isMethodSignature(grandparent)) {
            // Check if this is the return type (not a parameter type)
            if (grandparent.type === parent) return 'returns';
        }

        // Property/field type
        if (ts.isPropertyDeclaration(grandparent) || ts.isPropertySignature(grandparent)) {
            return 'field';
        }

        // Variable declaration type
        if (ts.isVariableDeclaration(grandparent)) return 'field';

        // Type parameter constraint: T extends Foo
        if (ts.isTypeParameterDeclaration(grandparent)) return 'extends';
    }

    // Call expression: Foo.method() or Foo() -- uses/creates
    if (ts.isCallExpression(parent) && parent.expression === node) {
        return 'creates';
    }

    // Property access: Foo.bar where Foo is a type being accessed statically
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        return 'uses';
    }

    // Extends/implements clause: class Bar extends Foo
    if (ts.isExpressionWithTypeArguments(parent)) {
        return 'extends';
    }

    // Heritage clause type references
    if (ts.isHeritageClause(parent)) {
        return 'extends';
    }

    return 'uses';
}

/**
 * Recursively set parent pointers on all AST nodes.
 * ts.createProgram() does not always set parent pointers on all nodes,
 * so we walk the tree and set them manually before analysis.
 *
 * @param {ts.Node} root - Root node to start from
 */
function setParents(root) {
    function walk(node) {
        ts.forEachChild(node, child => {
            child.parent = node;
            walk(child);
        });
    }
    walk(root);
}

/**
 * Find all references to changed types across the program.
 * Returns structured connection data matching Go's format.
 *
 * @param {ts.Program} program - TypeScript program with full type information
 * @param {Set<string>} changedTypeNames - Set of type names to find references for
 * @returns {Array<{ connectedType: string, sourceSymbol: string, relationship: string, location: string, method: string }>}
 */
function findConnectedTypes(program, changedTypeNames) {
    const connections = [];

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) continue;
        if (sourceFile.fileName.includes('node_modules')) continue;

        // First pass: set parent pointers on all nodes
        // ts.createProgram() does not always set parent pointers,
        // so we do it manually before analysis.
        setParents(sourceFile);
        visitNode(sourceFile);

        function visitNode(node) {
            // Check if this node references one of our changed types
            if (ts.isIdentifier(node) && changedTypeNames.has(node.text)) {
                const parent = node.parent;

                // Skip identifiers inside import/export declarations
                // (we only care about usage sites, not import statements)
                if (parent && (
                    ts.isImportSpecifier(parent) ||
                    ts.isImportClause(parent) ||
                    ts.isImportDeclaration(parent) ||
                    ts.isExportSpecifier(parent) ||
                    ts.isNamespaceImport(parent)
                )) {
                    ts.forEachChild(node, visitNode);
                    return;
                }

                const relFile = relative(PROJECT_ROOT, sourceFile.fileName);

                // Determine enclosing context (class + method)
                const enclosing = findEnclosingContext(node);

                // Skip self-references within the type's own definition
                if (enclosing.typeName === node.text) {
                    ts.forEachChild(node, visitNode);
                    return;
                }

                // Categorize the reference
                const category = categorizeReference(node, parent);

                // Get line number safely
                let lineNum;
                try {
                    lineNum = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
                } catch {
                    lineNum = 0;
                }

                if (enclosing.typeName || enclosing.functionName) {
                    connections.push({
                        connectedType: enclosing.typeName || `(function ${enclosing.functionName})`,
                        sourceSymbol: node.text,
                        relationship: category,
                        location: `${relFile}:${lineNum}`,
                        method: enclosing.methodName || enclosing.functionName || '',
                    });
                }
            }

            ts.forEachChild(node, visitNode);
        }
    }

    // Deduplicate by connectedType|sourceSymbol|relationship|method
    const seen = new Set();
    return connections.filter(c => {
        const key = `${c.connectedType}|${c.sourceSymbol}|${c.relationship}|${c.method}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) =>
        a.connectedType.localeCompare(b.connectedType) ||
        a.sourceSymbol.localeCompare(b.sourceSymbol) ||
        a.relationship.localeCompare(b.relationship)
    );
}

// ---------------------------------------------------------------------------
// Report generation (matching Go's format)
// ---------------------------------------------------------------------------

/**
 * Generate a formatted architecture review report.
 *
 * @param {{ added: string[], removed: string[], modified: Map<string, object[]> }} diff
 * @param {object} newGraph - Current graph data
 * @param {Array|null} connections - Connected-type analysis results
 * @returns {string} Formatted report
 */
function generateReport(diff, newGraph, connections) {
    const lines = [];

    lines.push('');
    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push(`${C.BOLD}                  ARCHITECTURE REVIEW REQUIRED${C.RESET}`);
    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push('');
    lines.push(`${C.INFO}The following structural changes were detected:${C.RESET}`);
    lines.push('');

    // Added modules
    for (const mod of diff.added) {
        lines.push(`${C.SUCCESS}NEW:${C.RESET} ${mod}`);
        const consumers = findConsumers(mod, newGraph);
        if (consumers.length > 0) {
            lines.push('  Consumers:');
            for (const c of consumers) lines.push(`    - ${c}`);
        } else {
            lines.push(`  ${C.WARN}No consumers yet (dead end)${C.RESET}`);
        }
        lines.push('');
    }

    // Removed modules
    for (const mod of diff.removed) {
        lines.push(`${C.ERROR}REMOVED:${C.RESET} ${mod}`);
        lines.push('');
    }

    // Modified modules
    for (const [mod, changes] of diff.modified) {
        lines.push(`${C.WARN}MODIFIED:${C.RESET} ${mod}`);

        for (const change of changes) {
            switch (change.type) {
                case 'added_class':
                    lines.push(`  - Added class: ${change.name}`);
                    break;
                case 'removed_class':
                    lines.push(`  - Removed class: ${change.name}`);
                    break;
                case 'added_methods':
                    for (const m of change.items) lines.push(`  - Added method: ${change.class}.${m}`);
                    break;
                case 'removed_methods':
                    for (const m of change.items) lines.push(`  - Removed method: ${change.class}.${m}`);
                    break;
                case 'added_properties':
                    for (const p of change.items) lines.push(`  - Added property: ${change.class}.${p}`);
                    break;
                case 'removed_properties':
                    for (const p of change.items) lines.push(`  - Removed property: ${change.class}.${p}`);
                    break;
                case 'changed_extends':
                    lines.push(`  - Changed extends: ${change.class}: ${change.from || 'none'} -> ${change.to || 'none'}`);
                    break;
                case 'added_interface':
                    lines.push(`  - Added interface: ${change.name}`);
                    break;
                case 'removed_interface':
                    lines.push(`  - Removed interface: ${change.name}`);
                    break;
                case 'added_interface_methods':
                    for (const m of change.items) lines.push(`  - Added interface method: ${change.interface}.${m}`);
                    break;
                case 'removed_interface_methods':
                    for (const m of change.items) lines.push(`  - Removed interface method: ${change.interface}.${m}`);
                    break;
                case 'added_interface_properties':
                    for (const p of change.items) lines.push(`  - Added interface property: ${change.interface}.${p}`);
                    break;
                case 'removed_interface_properties':
                    for (const p of change.items) lines.push(`  - Removed interface property: ${change.interface}.${p}`);
                    break;
                case 'added_enum':
                    lines.push(`  - Added enum: ${change.name}`);
                    break;
                case 'removed_enum':
                    lines.push(`  - Removed enum: ${change.name}`);
                    break;
                case 'added_exports':
                    for (const e of change.items) lines.push(`  - Added export: ${e}`);
                    break;
                case 'removed_exports':
                    for (const e of change.items) lines.push(`  - Removed export: ${e}`);
                    break;
                case 'added_functions':
                    for (const f of change.items) lines.push(`  - Added function: ${f}`);
                    break;
                case 'removed_functions':
                    for (const f of change.items) lines.push(`  - Removed function: ${f}`);
                    break;
                case 'added_imports':
                    for (const i of change.items) lines.push(`  - Added import: ${i}`);
                    break;
                case 'removed_imports':
                    for (const i of change.items) lines.push(`  - Removed import: ${i}`);
                    break;
            }
        }

        const consumers = findConsumers(mod, newGraph);
        if (consumers.length > 0) {
            lines.push('  Connected modules:');
            for (const c of consumers) lines.push(`    - ${c}`);
        }
        lines.push('');
    }

    // Connected-type analysis (Go-style rich context)
    if (connections && connections.length > 0) {
        lines.push(`${C.INFO}Connected types (via TypeScript compiler):${C.RESET}`);
        let currentType = null;
        for (const conn of connections) {
            if (conn.connectedType !== currentType) {
                if (currentType) lines.push('');
                lines.push(`  ${C.BOLD}${conn.connectedType}${C.RESET}`);
                currentType = conn.connectedType;
            }
            const relText = {
                creates: 'creates',
                param: 'takes param',
                returns: 'returns',
                field: 'used as field type in',
                uses: 'uses',
                extends: 'extends',
            }[conn.relationship] || conn.relationship;
            const methodText = conn.method ? ` in ${conn.method}()` : '';
            lines.push(`    -> ${relText} ${conn.sourceSymbol}${methodText} ${C.DIM}(${conn.location})${C.RESET}`);
        }
        lines.push('');
    }

    // Dead ends and orphans
    const deadEnds = findDeadEnds(newGraph);
    if (deadEnds.length > 0) {
        lines.push(`${C.WARN}Dead ends${C.RESET} (exported but never imported):`);
        for (const d of deadEnds) lines.push(`  - ${d}`);
        lines.push('');
    }

    const orphans = findOrphans(newGraph);
    if (orphans.length > 0) {
        lines.push(`${C.WARN}Orphans${C.RESET} (no imports and no exports):`);
        for (const o of orphans) lines.push(`  - ${o}`);
        lines.push('');
    }

    // Instructions (matching Go format)
    const reviewRelPath = relative(PROJECT_ROOT, REVIEW_FILE);
    lines.push(`${C.BOLD}Please review:${C.RESET}`);
    lines.push('  1. Will these changes negatively impact connected logic?');
    lines.push('  2. Do they fit the overall architecture?');
    lines.push(`  3. Update ${C.INFO}${reviewRelPath}${C.RESET} to reflect these changes`);
    lines.push('');
    lines.push(`${C.WARN}Stage ${reviewRelPath} and retry the commit.${C.RESET}`);
    lines.push('');
    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push('');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Test modes
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// --test-fingerprints: Verify fingerprinting and tracking file
if (args.includes('--test-fingerprints')) {
    info('Testing fingerprinting...');
    mkdirSync(DIAGRAMS_DIR, { recursive: true });
    const fp = computeFingerprints();
    console.log('Current fingerprints:', fp);
    writeTracking(fp);
    console.log('Tracking file written to:', TRACKING_FILE);
    console.log('Tracking matches:', sourcesMatchTracking());
    process.exit(0);
}

// --test-connections <TypeName>: Test connected-type analysis for debugging
if (args.includes('--test-connections')) {
    const typeNameIdx = args.indexOf('--test-connections') + 1;
    const typeName = args[typeNameIdx];
    if (!typeName) {
        error('--test-connections requires a type name');
        process.exit(2);
    }
    info(`Finding connections for: ${typeName}`);
    const program = createTSProgram();
    if (!program) {
        error('Failed to create TS program');
        process.exit(2);
    }
    const connections = findConnectedTypes(program, new Set([typeName]));
    if (connections.length === 0) {
        info(`No connections found for ${typeName}`);
    } else {
        info(`Found ${connections.length} connections:`);
        let currentType = null;
        for (const c of connections) {
            if (c.connectedType !== currentType) {
                if (currentType) console.log('');
                console.log(`  ${C.BOLD}${c.connectedType}${C.RESET}`);
                currentType = c.connectedType;
            }
            const relText = {
                creates: 'creates',
                param: 'takes param',
                returns: 'returns',
                field: 'used as field type in',
                uses: 'uses',
                extends: 'extends',
            }[c.relationship] || c.relationship;
            const methodText = c.method ? ` in ${c.method}()` : '';
            console.log(`    -> ${relText} ${c.sourceSymbol}${methodText} ${C.DIM}(${c.location})${C.RESET}`);
        }
    }
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

function main() {
    info('Validating architecture diagrams...');

    // Ensure output directory exists
    mkdirSync(DIAGRAMS_DIR, { recursive: true });

    // 1. Generate fresh diagrams
    let result;
    try {
        result = generate();
    } catch (err) {
        error(`Generation failed: ${err.message}`);
        process.exit(2);
    }

    // 2. Compare against existing .mmd files
    let diagramsChanged = false;
    const checks = [
        [MODULE_DEP_FILE, result.moduleDep],
        [CLASS_HIERARCHY_FILE, result.classHierarchy],
    ];
    for (const [file, content] of checks) {
        if (!existsSync(file) || readFileSync(file, 'utf-8') !== content) {
            diagramsChanged = true;
        }
    }

    // 3. If no changes, we're good
    if (!diagramsChanged) {
        success('Diagrams are up-to-date, no changes detected');
        process.exit(0);
    }

    // 4. Diagrams changed -- write updated files
    writeFileSync(MODULE_DEP_FILE, result.moduleDep);
    writeFileSync(CLASS_HIERARCHY_FILE, result.classHierarchy);
    writeFileSync(GRAPH_DATA_FILE, JSON.stringify(result.graphData, null, 2) + '\n');
    info('Updated diagram files');

    // 5. Load old graph data from git for diff analysis
    let oldGraph = {};
    const graphDataRel = relative(PROJECT_ROOT, GRAPH_DATA_FILE);
    const committedJson = getCommittedContent(graphDataRel);
    if (committedJson) {
        try {
            oldGraph = JSON.parse(committedJson);
        } catch {
            // Old file wasn't valid JSON -- treat as empty
        }
    }

    // 6. Run diff analysis
    const diff = diffGraphs(oldGraph, result.graphData);
    const hasStructuralChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.size > 0;

    // 7. Connected-type analysis + report (if structural changes)
    let connections = null;
    if (hasStructuralChanges) {
        // Collect changed type names for connected-type analysis
        const changedTypes = new Set();
        for (const [, changes] of diff.modified) {
            for (const change of changes) {
                if (change.name) changedTypes.add(change.name);
                if (change.class) changedTypes.add(change.class);
                if (change.interface) changedTypes.add(change.interface);
            }
        }

        if (changedTypes.size > 0) {
            try {
                const program = createTSProgram();
                if (program) {
                    connections = findConnectedTypes(program, changedTypes);
                }
            } catch (err) {
                warn(`Connected-type analysis failed: ${err.message}`);
            }
        }

        const report = generateReport(diff, result.graphData, connections);
        console.log(report);
    } else {
        info('Diagram text changed but no structural differences in graph data');
    }

    // 8. Check if fingerprints match tracking file (Go-style fast path)
    if (sourcesMatchTracking()) {
        success('Diagram sources match verified state');
        process.exit(0);
    }

    // 9. Check if review file is staged
    const reviewRelPath = relative(PROJECT_ROOT, REVIEW_FILE);
    if (isStaged(reviewRelPath)) {
        info(`Architecture changes detected and ${reviewRelPath} is staged`);
        const fp = computeFingerprints();
        writeTracking(fp);
        success('Tracking file updated');
        process.exit(0);
    }

    // 10. Block commit: review file not staged
    console.log('');
    error('Commit blocked: architecture diagrams have changed.');
    console.log('');
    console.log(`${C.BOLD}To proceed:${C.RESET}`);
    console.log(`  1. Update ${C.INFO}${reviewRelPath}${C.RESET} to reflect the changes`);
    console.log(`  2. Stage it: ${C.DIM}git add ${reviewRelPath}${C.RESET}`);
    console.log(`  3. Retry your commit`);
    console.log('');

    process.exit(1);
}

main();
