/**
 * `core-types.spec.ts`
 * - unit test for `core-types` (type shape of `NextContext`).
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2026-10-30 initial version (v5 B13: `channel`, `trace`).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { NextContext, NextTrace } from './core-types';

//! main test body.
describe('core-types', () => {
    const expect2 = (a: any) => expect(typeof a === 'function' ? a() : a);

    //* v5 B13: `channel` and `trace` are optional (an old context still compiles).
    it('should pass NextContext with channel and trace', () => {
        const trace: NextTrace = { tid: 'req-0', hop: 1, via: 'api://a-api#1.0.0', pid: 'req-0', src: 'api://a-api/x' };
        const ctx: NextContext = { requestId: 'req-1', channel: 'internal', trace };
        const old: NextContext = { requestId: 'req-2', depth: 1 };
        expect2(() => ctx.channel).toEqual('internal');
        expect2(() => ctx.trace).toEqual({
            tid: 'req-0',
            hop: 1,
            via: 'api://a-api#1.0.0',
            pid: 'req-0',
            src: 'api://a-api/x',
        });
        expect2(() => [old.channel, old.trace]).toEqual([undefined, undefined]);
        //* the 3 channels.
        const channels: NextContext['channel'][] = ['external', 'internal', 'local'];
        expect2(() => channels.length).toEqual(3);
    });
});
