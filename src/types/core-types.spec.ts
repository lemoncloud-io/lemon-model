/**
 * `core-types.spec.ts`
 * - unit test for `core-types` (type shape of `NextContext` and `NextIdentity`).
 *
 * @author      Steve Jung <steve@lemoncloud.io>
 * @date        2026-10-30 initial version (v5 B14: `channel`, `trace`).
 * @date        2026-10-30 v5 B15: `NextIdentity.cid`, `NextIdentity.aid`.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { NextContext, NextIdentity, NextTrace } from './core-types';

//! main test body.
describe('core-types', () => {
    const expect2 = (a: any) => expect(typeof a === 'function' ? a() : a);

    //* v5 B14: `channel` and `trace` are optional (an old context still compiles).
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

    //* v5 B15: `cid` and `aid` are optional, and kept as given.
    it('B15: should pass NextIdentity with cid and aid', () => {
        const identity: NextIdentity = { sid: 'lemon', uid: 'u1', cid: '123456789012', aid: 'auth-1' };
        const ctx: NextContext = { requestId: 'req-3', accountId: '123456789012', identity };
        expect2(() => [ctx.identity?.cid, ctx.identity?.aid]).toEqual(['123456789012', 'auth-1']);
        //* same cloud: the identity cid equals the receiver accountId.
        expect2(() => ctx.identity?.cid === ctx.accountId).toEqual(true);
        //* a copy (spread) keeps both fields.
        expect2(() => ({ ...identity })).toEqual({ sid: 'lemon', uid: 'u1', cid: '123456789012', aid: 'auth-1' });
    });

    //* v5 B15: an old identity (no `cid`, `aid`) still compiles.
    it('B15: should pass NextIdentity without cid and aid', () => {
        const old: NextIdentity = { sid: 'lemon', uid: 'u2', roles: ['user'] };
        expect2(() => [old.cid, old.aid]).toEqual([undefined, undefined]);
    });
});
