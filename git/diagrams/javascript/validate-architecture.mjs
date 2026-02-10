#!/usr/bin/env node
/**
 * validate-architecture.mjs — Validate that architecture diagrams are up-to-date
 * and that the review file is staged when structural changes are detected.
 *
 * Usage:
 *   node tools/validate-architecture.mjs
 *
 * Exit codes:
 *   0 — Diagrams are up-to-date, or diagrams changed AND review file is staged
 *   1 — Diagrams changed but review file is NOT staged (commit should be blocked)
 *   2 — Error during execution
 *
 * Configuration: diagrams.json in repo root (optional)
 *   See diagrams.sample.json for available options.
 *
 * Uses acorn-based graph data for diff analysis, consumer detection,
 * dead-end and orphan module identification.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import {
    generate,
    PROJECT_ROOT,
    DIAGRAMS_DIR,
    MODULE_DEP_FILE,
    CLASS_HIERARCHY_FILE,
    config,
} from './generate-diagrams.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_DATA_FILE = resolve(DIAGRAMS_DIR, 'graph-data.json');
const REVIEW_FILE = resolve(PROJECT_ROOT, config.reviewFile || 'docs/ARCHITECTURE.md');
const ENTRY_PATTERNS = (config.entryPatterns || ['main\\.js$', 'index\\.js$']).map(p => new RegExp(p));

// Colors
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

function info(msg) { console.log(`${C.INFO}[validate]${C.RESET} ${msg}`); }
function success(msg) { console.log(`${C.SUCCESS}[validate]${C.RESET} ${msg}`); }
function warn(msg) { console.error(`${C.WARN}[validate]${C.RESET} ${msg}`); }
function error(msg) { console.error(`${C.ERROR}[validate]${C.RESET} ${msg}`); }

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

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

/**
 * Compare old and new graph data to find what changed.
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

        // Check exports
        const addedExports = newMod.exports.filter(e => !oldMod.exports.includes(e));
        const removedExports = oldMod.exports.filter(e => !newMod.exports.includes(e));
        if (addedExports.length > 0) changes.push({ type: 'added_exports', items: addedExports });
        if (removedExports.length > 0) changes.push({ type: 'removed_exports', items: removedExports });

        // Check classes
        const oldClassNames = new Set(oldMod.classes.map(c => c.name));
        const newClassNames = new Set(newMod.classes.map(c => c.name));

        for (const cls of newMod.classes) {
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

        for (const oldCls of oldMod.classes) {
            if (!newClassNames.has(oldCls.name)) {
                changes.push({ type: 'removed_class', name: oldCls.name });
            }
        }

        // Check function exports
        const addedFunctions = newMod.functions.filter(f => !oldMod.functions.includes(f));
        const removedFunctions = oldMod.functions.filter(f => !newMod.functions.includes(f));
        if (addedFunctions.length > 0) changes.push({ type: 'added_functions', items: addedFunctions });
        if (removedFunctions.length > 0) changes.push({ type: 'removed_functions', items: removedFunctions });

        // Check import changes
        const oldImportTargets = new Set(oldMod.imports.map(i => i.target));
        const newImportTargets = new Set(newMod.imports.map(i => i.target));
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
 * Excludes modules matching entryPatterns (e.g., main.js, index.js).
 */
function findDeadEnds(graph) {
    const allModules = Object.keys(graph);
    const importedModules = new Set();

    for (const data of Object.values(graph)) {
        for (const imp of data.imports) {
            importedModules.add(imp.target);
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
// Report generation
// ---------------------------------------------------------------------------

function generateReport(diff, newGraph) {
    const lines = [];

    lines.push('');
    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push(`${C.BOLD}                  ARCHITECTURE CHANGES DETECTED${C.RESET}`);
    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push('');

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

    for (const mod of diff.removed) {
        lines.push(`${C.ERROR}REMOVED:${C.RESET} ${mod}`);
        lines.push('');
    }

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

    lines.push(`${C.BOLD}${'='.repeat(65)}${C.RESET}`);
    lines.push('');

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
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

    if (existsSync(MODULE_DEP_FILE)) {
        const existing = readFileSync(MODULE_DEP_FILE, 'utf-8');
        if (existing !== result.moduleDep) {
            diagramsChanged = true;
        }
    } else {
        diagramsChanged = true;
    }

    if (existsSync(CLASS_HIERARCHY_FILE)) {
        const existing = readFileSync(CLASS_HIERARCHY_FILE, 'utf-8');
        if (existing !== result.classHierarchy) {
            diagramsChanged = true;
        }
    } else {
        diagramsChanged = true;
    }

    // 3. If no changes, we're good
    if (!diagramsChanged) {
        success('Diagrams are up-to-date, no changes detected');
        process.exit(0);
    }

    // 4. Diagrams changed — write updated files
    writeFileSync(MODULE_DEP_FILE, result.moduleDep);
    writeFileSync(CLASS_HIERARCHY_FILE, result.classHierarchy);
    writeFileSync(GRAPH_DATA_FILE, JSON.stringify(result.graphData, null, 2) + '\n');
    info('Updated diagram files');

    // 5. Generate change report
    let oldGraph = {};
    const graphDataRel = relative(PROJECT_ROOT, GRAPH_DATA_FILE);
    try {
        const committedJson = execSync(`git show HEAD:${graphDataRel} 2>/dev/null`, {
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
        });
        oldGraph = JSON.parse(committedJson);
    } catch {
        oldGraph = {};
    }

    const diff = diffGraphs(oldGraph, result.graphData);
    const hasStructuralChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.modified.size > 0;

    if (hasStructuralChanges) {
        const report = generateReport(diff, result.graphData);
        console.log(report);
    } else {
        info('Diagram text changed but no structural differences in graph data');
    }

    // 6. Check if review file is staged
    const reviewRelPath = relative(PROJECT_ROOT, REVIEW_FILE);
    if (isStaged(reviewRelPath)) {
        success(`${reviewRelPath} is staged -- validation passed`);
        process.exit(0);
    }

    // 7. Not staged — block the commit
    console.log('');
    error('Commit blocked: architecture diagrams have changed.');
    console.log('');
    console.log(`${C.BOLD}To proceed:${C.RESET}`);
    console.log(`  1. Update ${C.INFO}${reviewRelPath}${C.RESET} to reflect the changes above`);
    console.log(`  2. Stage it: ${C.DIM}git add ${reviewRelPath}${C.RESET}`);
    console.log(`  3. Retry your commit`);
    console.log('');
    console.log(`${C.DIM}To bypass: git commit --no-verify${C.RESET}`);
    console.log('');

    process.exit(1);
}

main();
