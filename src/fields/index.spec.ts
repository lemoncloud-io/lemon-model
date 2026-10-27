/**
 * `fields/index.spec.ts`
 * - unit test for field annotations (`field`, `fieldsOf`, `specsOf`) in legacy decorator mode.
 * - the CJS/ESM cross-read test runs against the built `dist` (run `npm run build` first; skipped if absent).
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2026-10-28 initial version (lemon-core v5 B4)
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CoreModel, CORE_FIELDS } from '../types/core-storage';
import { field, fieldsOf, specsOf, FIELDS_KEY } from './index';

// sample models: a parent with 3 fields and a child that adds 2 and redeclares 1
class ParentModel {
    @field({ group: 'head' })
    id?: string;
    @field()
    name?: string;
    @field({ kind: 'view', group: ['head', 'list'] })
    stereo?: string;
}
class ChildModel extends ParentModel {
    @field()
    extra?: string;
    @field({ group: 'head' })
    declare name?: string;
    @field({ kind: 'internal' })
    secret?: string;
    // undecorated view field: never listed
    readonly $view?: string;
}

// the 14 L1 core names in the former literal order
const L1 = '$,ns,type,stereo,sid,uid,gid,lock,next,meta,createdAt,updatedAt,deletedAt,error';

//! main test body.
describe('fields', () => {
    const expect2 = (a: any) => expect(typeof a === 'function' ? a() : a);

    // legacy call stores an own, non-enumerable list on the class
    it('should register fields by legacy call', () => {
        expect2(() => fieldsOf(ParentModel).join(',')).toEqual('id,name,stereo');
        expect2(() => Object.prototype.hasOwnProperty.call(ParentModel, FIELDS_KEY)).toEqual(true);
        expect2(() => Object.keys(ParentModel)).toEqual([]);
        expect2(() => FIELDS_KEY === Symbol.for('lemon-model:fields:v1')).toEqual(true);
        // manual legacy call (prototype, key) works the same
        class Manual {}
        field()(Manual.prototype, 'a');
        field({ kind: 'view' })(Manual.prototype, 'b');
        expect2(() => fieldsOf(Manual).join(',')).toEqual('a,b');
        // static field is rejected
        expect(() => field()(Manual, 'x')).toThrow(/static/);
        // undecorated class has no field
        expect2(() => fieldsOf(class Empty {})).toEqual([]);
    });

    // child list = parent fields first, then own fields; the parent list is not touched
    it('should merge fields along the inheritance chain', () => {
        expect2(() => fieldsOf(ChildModel).join(',')).toEqual('id,name,stereo,extra,secret');
        expect2(() => fieldsOf(ParentModel).join(',')).toEqual('id,name,stereo');
        expect2(() => (ChildModel as any)[FIELDS_KEY].map((d: any) => d.name).join(',')).toEqual('extra,name,secret');
    });

    // redeclared name keeps the parent position and merges options (child wins per key)
    it('should keep parent position with child options on redeclare', () => {
        const name = specsOf(ChildModel).find(s => s.name === 'name');
        expect2(() =>
            specsOf(ChildModel)
                .map(s => s.name)
                .indexOf('name'),
        ).toEqual(1);
        expect2(() => name).toEqual({ name: 'name', kind: 'data', group: ['head'], own: true });
        // parent kind survives when the child gives group only
        class Redecl extends ParentModel {
            @field({ group: 'body' })
            declare stereo?: string;
        }
        expect2(() => specsOf(Redecl).find(s => s.name === 'stereo')).toEqual({
            name: 'stereo',
            kind: 'view',
            group: ['body'],
            own: true,
        });
        // child kind overrides parent kind
        class Rekind extends ParentModel {
            @field({ kind: 'data' })
            declare stereo?: string;
        }
        expect2(() => specsOf(Rekind).find(s => s.name === 'stereo')).toEqual({
            name: 'stereo',
            kind: 'data',
            group: ['head', 'list'],
            own: true,
        });
    });

    // group filter accepts string and string[] declarations
    it('should filter by group', () => {
        expect2(() => fieldsOf(ParentModel, { group: 'head' }).join(',')).toEqual('id,stereo');
        expect2(() => fieldsOf(ParentModel, { group: 'list' }).join(',')).toEqual('stereo');
        expect2(() => fieldsOf(ChildModel, { group: 'head' }).join(',')).toEqual('id,name,stereo');
        expect2(() => fieldsOf(ChildModel, { group: 'none' })).toEqual([]);
    });

    // kinds filter (default kind is data)
    it('should filter by kinds', () => {
        expect2(() => fieldsOf(ChildModel, { kinds: ['data'] }).join(',')).toEqual('id,name,extra');
        expect2(() => fieldsOf(ChildModel, { kinds: ['view', 'internal'] }).join(',')).toEqual('stereo,secret');
        expect2(() => fieldsOf(ChildModel, { group: 'head', kinds: ['view'] }).join(',')).toEqual('stereo');
    });

    // own flag tells whether the queried class itself declares the field
    it('should mark own fields in specsOf', () => {
        const own = (cls: any) =>
            specsOf(cls)
                .filter(s => s.own)
                .map(s => s.name)
                .join(',');
        expect2(() => own(ParentModel)).toEqual('id,name,stereo');
        expect2(() => own(ChildModel)).toEqual('name,extra,secret');
    });

    // CoreModel: 16 fields, L1 CORE_FIELDS = view + data (14, literal order)
    it('should derive CORE_FIELDS from CoreModel', () => {
        expect2(() => CORE_FIELDS.join(',')).toEqual(L1);
        expect2(() => fieldsOf(CoreModel).join(',')).toEqual(`${L1},id,_id`);
        expect2(() => fieldsOf(CoreModel, { kinds: ['internal'] }).join(',')).toEqual('id,_id');
        expect2(() => fieldsOf(CoreModel, { kinds: ['view'] }).join(',')).toEqual('$');
        // a consumer model extends CoreModel with its own fields
        class MyModel extends CoreModel<'my'> {
            @field({ group: 'head' })
            name?: string;
        }
        expect2(() => fieldsOf(MyModel).length).toEqual(17);
        expect2(() => fieldsOf(MyModel, { group: 'head' })).toEqual(['name']);
        // object literal typed as CoreModel still compiles (fields only)
        const literal: CoreModel = { id: 'a', ns: 'TT' };
        expect2(() => literal.id).toEqual('a');
    });

    // two module copies (CJS dist + ESM dist) read each other's lists via the Symbol.for key
    it('should cross-read between CJS and ESM builds', () => {
        const root = path.resolve(__dirname, '../..');
        const cjsFile = path.join(root, 'dist/index.js');
        const esmFile = path.join(root, 'dist/esm/index.js');
        // skip gracefully without a build
        if (!fs.existsSync(cjsFile) || !fs.existsSync(esmFile)) return;
        const script = `
            import { createRequire } from 'module';
            import { pathToFileURL } from 'url';
            const cjs = createRequire(import.meta.url)(${JSON.stringify(cjsFile)});
            const esm = await import(pathToFileURL(${JSON.stringify(esmFile)}).href);
            class A extends cjs.CoreModel {}
            cjs.field({ group: 'head' })(A.prototype, 'name');
            class B extends esm.CoreModel {}
            esm.field({ group: 'head' })(B.prototype, 'name');
            const out = {
                sameClass: cjs.CoreModel === esm.CoreModel,
                coreCross: esm.fieldsOf(cjs.CoreModel).join(','),
                coreCross2: cjs.fieldsOf(esm.CoreModel).join(','),
                l1: [cjs.CORE_FIELDS.join(','), esm.CORE_FIELDS.join(',')],
                aByEsm: esm.fieldsOf(A).join(','),
                bByCjs: cjs.fieldsOf(B).join(','),
                headA: esm.fieldsOf(A, { group: 'head' }).join(','),
            };
            console.log(JSON.stringify(out));
        `;
        const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
        const out = JSON.parse(stdout.trim().split('\n').pop());
        const L2 = `${L1},id,_id`;
        expect2(() => out.sameClass).toEqual(false);
        expect2(() => out.coreCross).toEqual(L2);
        expect2(() => out.coreCross2).toEqual(L2);
        expect2(() => out.l1).toEqual([L1, L1]);
        expect2(() => out.aByEsm).toEqual(`${L2},name`);
        expect2(() => out.bByCjs).toEqual(`${L2},name`);
        expect2(() => out.headA).toEqual('name');
    });
});
