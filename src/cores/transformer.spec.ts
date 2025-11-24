/**
 * `transformer.spec.ts`
 * - test script for `transformer.spec.ts`
 *
 *
 * @author      Steve <steve@lemoncloud.io>
 * @date        2023-01-19 initial version
 *
 * @copyright (C) 2023 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, TestModel, TestTransformer } from './index.spec';
import { Cores } from './transformer';

//! create instance.
export const instance = () => {
    const trans = new (class extends TestTransformer {})();
    return { trans };
};

//! main test body.
describe('TestTransformer', () => {
    //! test transformer
    it('should pass test transformer', async () => {
        const { trans } = instance();

        expect2(() => trans.onlyDefined(null as any)).toEqual(null);

        expect2(() => trans.modelAsView(null as any)).toEqual(null);
        expect2(() => trans.bodyToModel(null as any)).toEqual(null);

        expect2(() => trans.modelAsView(1 as any)).toEqual(null);
        expect2(() => trans.bodyToModel(1 as any)).toEqual(null);

        expect2(() => trans.modelAsView([] as any)).toEqual({ ko: '' });
        expect2(() => trans.bodyToModel([] as any)).toEqual({});

        expect2(() => trans.modelAsView({})).toEqual({
            ko: '',
        });

        expect2(() => trans.modelAsView({ sid: 's', uid: '' })).toEqual({
            ko: '',
        });
        expect2(() => trans.modelAsView({ sid: 's', gid: 'g', uid: 'u', next: 1, lock: 0 }, true)).toEqual({
            ko: '',
            $: {
                gid: 'g',
                sid: 's',
                uid: 'u',
            },
        });

        expect2(() => trans.modelAsView({ name: '2', test: 0, bool: 1 })).toEqual({
            ko: '',
            name: '2',
            test: 0,
            bool: true,
        });

        expect2(() => trans.bodyToModel({ name: '2', id: '' })).toEqual({
            id: '',
            name: '2',
        });
        expect2(() => trans.bodyToModel({ name: '2', id: null as any }, true)).toEqual({
            id: '',
            name: '2',
        });
        expect2(() => trans.bodyToModel({ id: null as any })).toEqual({
            id: '',
        });

        const expected: TestModel = {
            id: 'I',
            name: 'x',
            test: 1,
            bool: 0,
            error: 'E',
            extra: {},
        };
        expect2(() => trans.bodyToModel(trans.modelAsView({ ...expected }))).toEqual({
            ...expected,
            extra: undefined,
            error: undefined, //* immutable
        });

        //! test of asCores().
        expect2(() => trans.asCores()).toEqual();
        expect2(() => trans.asCores(null as any)).toEqual();
        expect2(() => trans.asCores({})).toEqual({});
        expect2(() => trans.asCores({ rev: 0 })).toEqual({ rev: 0 });
        expect2(() => trans.asCores(undefined, {})).toEqual(undefined);
        expect2(() => trans.asCores(undefined, { sid: null as any })).toEqual(undefined);
        expect2(() => trans.asCores(undefined, { sid: '' })).toEqual({ sid: '' });

        const cores: Cores = { aid: 'A', sid: '', gid: null as any, uid: 'U', rev: null as any };
        const expCores: Cores = { aid: 'A', sid: '', uid: 'U' };
        expect2(() => trans.asCores(cores)).toEqual({ ...expCores });
        expect2(() => trans.asCores(undefined, cores)).toEqual({ ...expCores });
        expect2(() => trans.modelAsView({ id: 'I', $: cores })).toEqual({ id: 'I', ko: '', $: expCores });
        expect2(() => trans.modelAsView({ id: 'I', $: cores }, true)).toEqual({ id: 'I', ko: '', $: {} });
        expect2(() => trans.modelAsView({ id: 'I', ...cores })).toEqual({ id: 'I', ko: '' });
        expect2(() => trans.modelAsView({ id: 'I', ...cores }, true)).toEqual({ id: 'I', ko: '', $: expCores });

        //! test asDate().
        expect2(() => trans.asDate(null as any)).toEqual('');
        expect2(() => trans.asDate('22-01-22')).toEqual('.date[22-01-22] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-00-22')).toEqual('.date[2022-00-22] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-01-00', 'some')).toEqual('.some[2022-01-00] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-01-22')).toEqual('2022-01-22');
    });
});
