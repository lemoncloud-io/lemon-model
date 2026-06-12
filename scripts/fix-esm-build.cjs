/**
 * `scripts/fix-esm-build.cjs`
 * - post-process the TypeScript ESM build so Node can load it as real ESM.
 * - adds file extensions to relative imports and marks `dist/esm` as `type: module`.
 *
 * @copyright (C) LemonCloud Co Ltd. - All Rights Reserved.
 */
const fs = require('fs');
const path = require('path');

const esmRoot = path.resolve(__dirname, '..', 'dist', 'esm');

/** Convert a platform-specific filesystem path to a POSIX-style import path. */
const toPosix = value => value.split(path.sep).join('/');

/** Return true when an import specifier already has a file extension. */
const hasExtension = specifier => /\.[a-zA-Z0-9]+$/.test(specifier);

/** Resolve an extensionless relative import to the generated ESM file target. */
const resolveSpecifier = (fromFile, specifier) => {
    if (!specifier.startsWith('.') || hasExtension(specifier)) return specifier;

    const base = path.resolve(path.dirname(fromFile), specifier);
    const fileTarget = `${base}.js`;
    const indexTarget = path.join(base, 'index.js');

    // TypeScript ES2020 output keeps extensionless imports; Node ESM does not.
    if (fs.existsSync(fileTarget)) return `${specifier}.js`;
    if (fs.existsSync(indexTarget)) return `${specifier}/index.js`;
    return specifier;
};

/** Rewrite relative import specifiers in one generated JavaScript file. */
const fixFile = file => {
    const source = fs.readFileSync(file, 'utf8');
    const fixed = source
        .replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (_match, prefix, specifier, suffix) => {
            return `${prefix}${toPosix(resolveSpecifier(file, specifier))}${suffix}`;
        })
        .replace(/(import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/g, (_match, prefix, specifier, suffix) => {
            return `${prefix}${toPosix(resolveSpecifier(file, specifier))}${suffix}`;
        });

    if (fixed !== source) fs.writeFileSync(file, fixed);
};

/** Walk the generated ESM tree and patch every JavaScript file. */
const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) fixFile(fullPath);
    }
};

if (!fs.existsSync(esmRoot)) {
    throw new Error(`ESM build directory not found: ${esmRoot}`);
}

/** Patch all generated files before writing the local ESM package marker. */
walk(esmRoot);

// Keep the root package CommonJS while letting `dist/esm/*.js` behave as ESM.
fs.writeFileSync(path.join(esmRoot, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
