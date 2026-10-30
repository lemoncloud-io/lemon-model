/**
 * `strict-consumer.spec.ts`
 * - regression test: the published type declarations compile under a `strict` consumer without `skipLibCheck`.
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2026-10-30 initial version (v5 B17: TS2411 on `SimpleSearchParam` via `GeneralItem`).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

//* v5 B17: the options of a strict consumer (no `skipLibCheck`, no ambient `@types`).
const STRICT: ts.CompilerOptions = {
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    experimentalDecorators: true,
    types: [],
};

//* v5 B17: type-check the given root files, and return the diagnostics as `TS<code> <file>: <message>` lines.
const diagnosticsOf = (files: string[], options: ts.CompilerOptions = STRICT): string[] => {
    const program = ts.createProgram(files, options);
    return ts.getPreEmitDiagnostics(program).map(d => {
        const file = d.file ? path.basename(d.file.fileName) : '-';
        return `TS${d.code} ${file}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
};

//* v5 B17: the published entry (`dist/index.d.ts`) exists only after `npm run build`.
const ROOT = path.resolve(__dirname, '../..');
const DIST_DTS = path.join(ROOT, 'dist/index.d.ts');
const itDist = fs.existsSync(DIST_DTS) ? it : it.skip;

//! main test body.
describe('strict-consumer', () => {
    const expect2 = (a: any) => expect(typeof a === 'function' ? a() : a);
    let tmp = '';

    //* v5 B17: temp consumer files live under `os.tmpdir()`.
    beforeAll(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-model-b17-'));
    });

    //* v5 B17: clean up the temp consumer files.
    afterAll(() => {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });

    //* v5 B17: skipped before `npm run build` (no `dist/`); the coordinator runs it again after the build.
    itDist('B17 T-01: a strict consumer of dist/index.d.ts has 0 diagnostics', () => {
        const entry = DIST_DTS.replace(/\.d\.ts$/, '')
            .split(path.sep)
            .join('/');
        const file = path.join(tmp, 'a.ts');
        const code = [
            `import { CoreModel, SimpleSearchParam } from '${entry}';`,
            `export const x = CoreModel;`,
            `export const p: SimpleSearchParam = { $limit: 10, $page: 0, $exists: 'name' };`,
            '',
        ].join('\n');
        fs.writeFileSync(file, code);
        expect2(() => diagnosticsOf([file])).toEqual([]);
    });

    //* v5 B17: the source itself compiles under `strict` (runs before a build too).
    it('B17 T-02: src/types/core-types.ts has 0 diagnostics under strict', () => {
        const file = path.join(ROOT, 'src/types/core-types.ts');
        expect2(() => diagnosticsOf([file])).toEqual([]);
    });
});
