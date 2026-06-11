/**
 * `scripts/check-package-exports.cjs`
 * - smoke-test the public package exports in both CommonJS and ESM modes.
 * - catches package.json `exports` regressions before publish.
 *
 * @copyright (C) LemonCloud Co Ltd. - All Rights Reserved.
 */
/** Public package entry points that must work in both package module systems. */
const publicModuleNames = ['lemon-model', 'lemon-model/genai/testing', 'lemon-model/socket/testing'];

/** Return runtime export names that should be shared between CommonJS and ESM. */
const getPublicExportNames = loaded => {
    return Object.keys(loaded)
        .filter(name => name !== 'default' && name !== '__esModule')
        .sort();
};

/** Load each public entry with CommonJS and use it as the runtime export baseline. */
const loadCommonJSContracts = () => {
    return publicModuleNames.map(moduleName => {
        const loaded = require(moduleName);
        const exportNames = getPublicExportNames(loaded);
        if (exportNames.length === 0) throw new Error(`CommonJS require ${moduleName} has no public exports`);
        return { moduleName, exportNames };
    });
};

/** Assert that the ESM entry exposes the same runtime names as the CommonJS entry. */
const assertSameExports = (moduleName, cjsNames, esmNames) => {
    const missing = cjsNames.filter(name => !esmNames.includes(name));
    const extra = esmNames.filter(name => !cjsNames.includes(name));

    if (missing.length || extra.length) {
        throw new Error(
            [
                `ESM import ${moduleName} does not match CommonJS exports`,
                missing.length ? `missing: ${missing.join(', ')}` : undefined,
                extra.length ? `extra: ${extra.join(', ')}` : undefined,
            ]
                .filter(Boolean)
                .join(' - '),
        );
    }
};

/** Load each public entry with native ESM and compare it against the CommonJS baseline. */
const checkESM = async contracts => {
    for (const contract of contracts) {
        const loaded = await import(contract.moduleName);
        const exportNames = getPublicExportNames(loaded);
        assertSameExports(contract.moduleName, contract.exportNames, exportNames);
    }
};

/** Run both module-system checks as one publish-time smoke test. */
(async () => {
    const contracts = loadCommonJSContracts();
    await checkESM(contracts);
    console.log('package exports smoke test passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
