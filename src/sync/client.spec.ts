/**
 * `client.spec.ts`
 * - L3 socket client runtime test.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, GETERR } from '../cores/index.spec';
import { SocketMessage } from '../socket/types';
import { createSocketClient } from './client';
import { createPeerBridge } from './testing';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

describe('client', () => {
    it('should resolve request() on result and reject on error, matched by mid', async () => {
        //! `ping`/`pong` are reserved by `Peer.dispatch` for its own keep-alive handshake and never
        //! reach `server.onMessage()`; use a plain custom type for the echo case here.
        const { network, server, clientId } = createPeerBridge();
        server.onMessage((message: SocketMessage) => {
            if (message.type === 'echo') return { ok: true, echo: message.data };
            if (message.type === 'boom') {
                server.post({ type: 'error', data: { code: 'BOOM' }, mid: message.mid }, { clientId });
                //! `Peer.dispatch` turns ANY listener return value (even `undefined`) into a second,
                //! automatic `result` reply for the same mid. Throwing instead of returning keeps this
                //! explicit `error` post the only reply, so it can't lose a race against a spurious one.
                throw new Error(`@type[${message.type}] replied manually - test.server`);
            }
            throw new Error(`@type[${message.type}] unhandled - test.server`);
        });
        const client = createSocketClient(network);

        expect2(await client.request('echo', { a: 1 })).toEqual({ ok: true, echo: { a: 1 } });
        expect2(await client.request('boom', null).catch(error => error)).toEqual({ code: 'BOOM' });
        expect2(() => client.pendingCount).toEqual(0);
    });

    it('should reject on timeout (default and per-request override) and clear pending', async () => {
        const { network, server } = createPeerBridge();
        server.onMessage((message: SocketMessage) => {
            throw new Error(`@type[${message.type}] never replies - test.server`);
        });
        const client = createSocketClient(network, { timeoutMs: 20 });

        const defaultTimeout = await client.request('slow', null).catch(GETERR);
        expect2(() => defaultTimeout.includes('timeout')).toEqual(true);
        expect2(() => client.pendingCount).toEqual(0);

        const overrideTimeout = await client.request('slow', null, { timeoutMs: 5 }).catch(GETERR);
        expect2(() => overrideTimeout.includes('timeout')).toEqual(true);
        expect2(() => client.pendingCount).toEqual(0);
    });

    it('should drop a late response arriving after timeout without leaking it as a message', async () => {
        const { network, server, clientId } = createPeerBridge();
        let capturedMid: string | undefined;
        server.onMessage((message: SocketMessage) => {
            capturedMid = message.mid;
            throw new Error(`@type[${message.type}] held for late reply - test.server`);
        });
        const client = createSocketClient(network, { timeoutMs: 10 });
        const messages: SocketMessage[] = [];
        client.onMessage(message => messages.push(message));

        const timedOut = await client.request('slow', null).catch(GETERR);
        expect2(() => timedOut.includes('timeout')).toEqual(true);

        server.post({ type: 'result', data: { late: true }, mid: capturedMid as string }, { clientId });
        await wait();

        expect2(() => messages).toEqual([]);
    });

    it('should drop an unmatched result/error that was never requested', async () => {
        const { network, serverNetwork } = createPeerBridge();
        const client = createSocketClient(network);
        const messages: SocketMessage[] = [];
        client.onMessage(message => messages.push(message));

        serverNetwork.send(JSON.stringify({ type: 'result', data: { orphan: true }, mid: 'never-requested' }));
        serverNetwork.send(JSON.stringify({ type: 'error', data: { orphan: true }, mid: 'never-requested-2' }));
        await wait();

        expect2(() => messages).toEqual([]);
    });

    it('should reject requests beyond maxPending immediately without sending them', async () => {
        const { network, server } = createPeerBridge();
        const received: string[] = [];
        server.onMessage((message: SocketMessage) => {
            received.push(message.type);
            throw new Error(`@type[${message.type}] held - test.server`);
        });
        const client = createSocketClient(network, { maxPending: 1, timeoutMs: 20 });

        const held = client.request('hold', null).catch(GETERR);
        expect2(() => client.pendingCount).toEqual(1);

        const overflow = await client.request('overflow', null).catch(GETERR);
        expect2(() => overflow.includes('maxPending')).toEqual(true);
        expect2(() => client.pendingCount).toEqual(1);
        await wait();
        expect2(() => received).toEqual(['hold']);

        await held; // drain the held request's own timeout so no timer leaks past the test
    });

    it('should convert a synchronous send() throw (packet too big) into a request reject', async () => {
        const { network, server } = createPeerBridge({ client: { maxPacketBytes: 48 } });
        server.onMessage(() => {
            throw new Error(`@server should not receive an oversized packet - test.server`);
        });
        const client = createSocketClient(network);

        const error = await client
            .request('large', { text: 'this payload is intentionally too large for the limit' })
            .catch(GETERR);
        expect2(() => error).toEqual('1009: message too big');
        expect2(() => client.pendingCount).toEqual(0);
    });

    it('should convert a synchronous send() throw (packet too big) into onError for post()', async () => {
        const { network, server } = createPeerBridge({ client: { maxPacketBytes: 48 } });
        server.onMessage(() => {
            throw new Error(`@server should not receive an oversized packet - test.server`);
        });
        const client = createSocketClient(network);
        const errors: string[] = [];
        const scopes: string[] = [];
        client.onError((error, context) => {
            errors.push(GETERR(error));
            scopes.push(context.scope);
        });

        expect2(() => client.post('large', { text: 'this payload is intentionally too large for the limit' })).toEqual(
            undefined,
        );
        expect2(() => errors).toEqual(['1009: message too big']);
        expect2(() => scopes).toEqual(['socketClient.post']);
    });

    it('should wrap the network with the raw filter and ignore raw not accepted by it', async () => {
        const { network, serverNetwork } = createPeerBridge();
        const filter = (raw: string) => {
            try {
                return `${JSON.parse(raw)?.type ?? ''}`.startsWith('sync/');
            } catch {
                return false;
            }
        };
        const client = createSocketClient(network, { filter });
        const messages: SocketMessage[] = [];
        const typed: any[] = [];
        client.onMessage(message => messages.push(message));
        client.onType('sync/user:updated', data => typed.push(data));

        serverNetwork.send(JSON.stringify({ type: 'json:manifest', tid: 't1', root: {}, refs: [] }));
        serverNetwork.send(JSON.stringify({ type: 'sync/user:updated', data: { id: 'u1' }, mid: 'evt-1' }));
        await wait();

        expect2(() => messages.map(message => message.type)).toEqual(['sync/user:updated']);
        expect2(() => typed).toEqual([{ id: 'u1' }]);
    });

    it('should quietly ignore raw that does not parse as an envelope when no filter is set', async () => {
        const { network, serverNetwork } = createPeerBridge();
        const client = createSocketClient(network);
        const messages: SocketMessage[] = [];
        const errors: string[] = [];
        client.onMessage(message => messages.push(message));
        client.onError(error => errors.push(GETERR(error)));

        serverNetwork.send('not-json-at-all');
        serverNetwork.send(JSON.stringify({ noType: true }));
        await wait();

        expect2(() => messages).toEqual([]);
        expect2(() => errors).toEqual([]);
    });

    it('should reject all pending and detach listeners on close() without closing the network', async () => {
        const { network, server } = createPeerBridge();
        server.onMessage((message: SocketMessage) => {
            throw new Error(`@type[${message.type}] held - test.server`);
        });
        const client = createSocketClient(network);

        const pending = client.request('hold', null).catch(GETERR);
        expect2(() => client.pendingCount).toEqual(1);

        client.close();

        const errorMessage = await pending;
        expect2(() => errorMessage.includes('is closed')).toEqual(true);
        expect2(() => network.readyState).toEqual('open');

        // guarded after close: request rejects, post throws (instead of silently timing out)
        const afterClose = await client.request('again', null).catch(GETERR);
        expect2(() => afterClose.includes('is closed')).toEqual(true);
        expect2(() => client.post('again', null)).toEqual('@socketClient is closed - socketClient.post(again)');
    });
});
