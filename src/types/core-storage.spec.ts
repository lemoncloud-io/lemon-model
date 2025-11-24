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
import { SearchBody } from './core-types';

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
            'error',
            '$',
            'createdAt',
            'updatedAt',
            'deletedAt',
        ]);
    });

    it('should pass type checking', () => {
        const embedding = 'sm3';
        const size = 10;
        const vector = [0.1, 0.2, 0.3, 0.4, 0.5]; // Example vector, should match the embedding size

        const body: SearchBody = {
            query: {
                bool: {
                    must: [
                        {
                            knn: {
                                [`vector$.${embedding}`]: {
                                    vector,
                                    k: size,
                                },
                            },
                        },
                    ],
                    filter: [{ term: { 'ns.keyword': 'TT' } }, { term: { deletedAt: 0 } }],
                },
            },
            size,
            _source: ['id', `vector$.${embedding}`, '_score'],
        };
        expect(body.size).toEqual(size);
    });
});
