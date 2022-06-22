/**
 * `core-storage.spec.ts`
 * - unit test for `core-storage`
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2022-06-20 initial version
 *
 * @copyright (C) 2022 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { CORE_FIELDS } from './core-storage';

//! main test body.
describe('core-storage', () => {
    const expect2 = (a: any) => expect(typeof a === 'function' ? a() : a);
    it('should pass basic definitions', () => {
        expect2(() => CORE_FIELDS).toEqual([
            'ns',
            'type',
            'stereo',
            'sid',
            'uid',
            'gid',
            'lock',
            'next',
            'meta',
            'createdAt',
            'updatedAt',
            'deletedAt',
        ]);
    });
});
