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

//! create instance.
export const instance = () => {
    const trans = new TestTransformer();
    return { trans };
};

//! main test body.
describe('TestTransformer', () => {
    //! test transformer
    it('should pass test transformer', async () => {
        const { trans } = instance();

        expect2(() => trans.onlyDefined(undefined)).toEqual(undefined);
        expect2(() => trans.onlyDefined(null)).toEqual(null);
        expect2(() => trans.onlyDefined('' as any)).toEqual(null);
        expect2(() => trans.onlyDefined(0 as any)).toEqual(null);
        expect2(() => trans.onlyDefined(false as any)).toEqual(null);
        expect2(() => trans.onlyDefined(true as any)).toEqual(null);

        expect2(() => trans.modelAsView(null as any)).toEqual(null);
        expect2(() => trans.bodyToModel(null as any)).toEqual(null);

        expect2(() => trans.modelAsView(1 as any)).toEqual(null);
        expect2(() => trans.bodyToModel(1 as any)).toEqual(null);

        expect2(() => trans.modelAsView([] as any)).toEqual({ ko: '' });
        expect2(() => trans.bodyToModel([] as any)).toEqual({});

        expect2(() => trans.modelAsView({})).toEqual({
            ko: '',
        });

        const M = { sid: 's', gid: 'g', uid: 'u' };
        expect2(() => trans.modelAsView({ ...M })).toEqual({
            ko: '',
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, lock: 0 }, true)).toEqual({
            ko: '',
            $: { ...M },
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: { uid: 'x' } }, true)).toEqual({
            ko: '',
            $: { ...M },
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: null as any }, true)).toEqual({
            ko: '',
            $: { ...M },
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: {} as any }, true)).toEqual({
            ko: '',
            $: { ...M },
        });

        //* check default view without cores
        expect2(() => trans.modelAsView({ ...M, next: 1, $: { uid: 'x' } }, false)).toEqual({
            ko: '',
            $: { uid: 'x' },
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: null as any }, false)).toEqual({
            ko: '',
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: undefined as any }, false)).toEqual({
            ko: '',
        });
        expect2(() => trans.modelAsView({ ...M, next: 1, $: {} as any }, false)).toEqual({
            ko: '',
            $: {},
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

        //! test asDate().
        expect2(() => trans.asDate(null as any)).toEqual('');
        expect2(() => trans.asDate('' as any)).toEqual('');
        expect2(() => trans.asDate('22-01-22')).toEqual('.date[22-01-22] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-00-22')).toEqual('.date[2022-00-22] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-01-00', 'some')).toEqual('.some[2022-01-00] is invalid format - asDate()');
        expect2(() => trans.asDate('2022-01-22')).toEqual('2022-01-22');
    });
});
