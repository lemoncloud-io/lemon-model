/**
 * `transport.spec.ts`
 * - JSON transport test.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import {
    assembleJSON,
    calculateJSONTransportChunkBytes,
    createJSONTransport,
    isJSONReliableScope,
    JSON_RELIABLE_SCOPE,
    JSONReceiveState,
    JSONTransportReliableError,
    NetworkSupportable,
    onReliableError,
    ReliableOptions,
    SocketErrorContext,
    SocketLogEntry,
    SocketReadyState,
    JSONTransportPacket,
    splitJSON,
} from './index';
//! the in-memory simulator is isolated from the root barrel — import it directly for tests.
import { createNetwork } from './socket';

const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const repeat = (value: string, count: number) => new Array(count + 1).join(value);
const uniquePayload = (count: number) =>
    Array.from({ length: count }, (_, index) => `part-${String(index).padStart(2, '0')}|`).join('');
const identityProvider = () => {
    let tid = 0;
    let cid = 0;
    return {
        nextTransportId: () => `tid-${++tid}`,
        nextChunkId: () => `cid-${++cid}`,
    };
};

//! thin network wrapper that selectively drops raw packets before they reach the real network.
const withDrop = (network: NetworkSupportable, shouldDrop: (raw: string) => boolean): NetworkSupportable => ({
    get readyState() {
        return network.readyState;
    },
    send: data => {
        if (!shouldDrop(data)) network.send(data);
    },
    onMessage: handler => network.onMessage(handler),
    onError: handler => network.onError(handler),
    close: (code?: number, reason?: string) => network.close(code, reason),
});

//! thin network wrapper that tampers with a chunk's data (breaking its hash) before delivery.
const withCorrupt = (
    network: NetworkSupportable,
    shouldCorrupt: (packet: JSONTransportPacket) => boolean,
): NetworkSupportable => ({
    get readyState() {
        return network.readyState;
    },
    send: raw => {
        const packet = JSON.parse(raw) as JSONTransportPacket;
        if (packet.type === 'json:chunk' && shouldCorrupt(packet)) {
            network.send(JSON.stringify({ ...packet, data: `${packet.data}-tampered` }));
            return;
        }
        network.send(raw);
    },
    onMessage: handler => network.onMessage(handler),
    onError: handler => network.onError(handler),
    close: (code?: number, reason?: string) => network.close(code, reason),
});

//! thin network wrapper whose readyState can be forced, to simulate reconnect windows.
const withReadyState = (network: NetworkSupportable, stateBox: { value?: SocketReadyState }): NetworkSupportable => ({
    get readyState() {
        return stateBox.value ?? network.readyState;
    },
    send: data => network.send(data),
    onMessage: handler => network.onMessage(handler),
    onError: handler => network.onError(handler),
    close: (code?: number, reason?: string) => network.close(code, reason),
});

const shortReliable = (overrides?: Partial<ReliableOptions>): ReliableOptions => ({
    nackDebounceMs: 10,
    resendIntervalMs: 300,
    maxAttempts: 5,
    settledTtlMs: 200,
    settledMaxEntries: 10,
    ...overrides,
});

describe('json transport', () => {
    it('should round-trip a small GenAI text response without refs', () => {
        const input = { type: 'text' as const, data: { text: 'hello', model: 'test' } };
        const split = splitJSON(input, { largeValueBytes: 64, chunkBytes: 16 });
        const state: JSONReceiveState = {
            tid: split.tid,
            manifest: split.manifest,
            complete: true,
            updatedAt: Date.now(),
            chunks: new Map(),
        };

        expect2(() => split.manifest.refs).toEqual([]);
        expect2(() => split.chunks).toEqual([]);
        expect2(() => assembleJSON(state)).toEqual(input);
    });

    it('should split and assemble a large inline image response', () => {
        const input = {
            type: 'image' as const,
            data: {
                mimeType: 'image/png',
                inlineData: repeat('a', 1024),
            },
        };
        const split = splitJSON(input, { largeValueBytes: 16, chunkBytes: 128 });
        const state: JSONReceiveState = {
            tid: split.tid,
            manifest: split.manifest,
            complete: true,
            updatedAt: Date.now(),
            chunks: new Map(),
        };

        for (const chunk of split.chunks) {
            let byIndex = state.chunks.get(chunk.cid);
            if (!byIndex) {
                byIndex = new Map();
                state.chunks.set(chunk.cid, byIndex);
            }
            byIndex.set(chunk.index, chunk);
        }

        expect2(() => split.manifest.refs.length).toEqual(1);
        expect2(() => split.manifest.refs[0].path).toEqual('/data/inlineData');
        expect2(() => split.chunks.length > 1).toEqual(true);
        expect2(() => split.size.originalBytes > split.size.manifestBytes).toEqual(true);
        expect2(() => split.size.totalPacketBytes > split.size.originalBytes).toEqual(true);
        expect2(() => split.size.overheadBytes).toEqual(split.size.totalPacketBytes - split.size.originalBytes);
        expect2(() => assembleJSON(state)).toEqual(input);
    });

    it('should use an injected identity provider for transport and chunk ids', () => {
        const split = splitJSON(
            { type: 'image' as const, data: { inlineData: repeat('a', 40), mimeType: 'image/png' } },
            { largeValueBytes: 16, chunkBytes: 10, identityProvider: identityProvider() },
        );

        expect2(() => split.tid).toEqual('tid-1');
        expect2(() => split.manifest.refs[0].cid).toEqual('cid-1');
        expect2(() => split.chunks.map(chunk => chunk.tid)).toEqual(split.chunks.map(() => 'tid-1'));
        expect2(() => split.chunks.map(chunk => chunk.cid)).toEqual(split.chunks.map(() => 'cid-1'));
    });

    it('should preserve user ref marker objects unless listed in refs', () => {
        const input = {
            type: 'tool-result' as const,
            data: {
                output: repeat('result-', 20),
                marker: { $jsonTransportRef: 'user-value' },
            },
        };
        const split = splitJSON(input, { largeValueBytes: 16, chunkBytes: 24 });
        const state: JSONReceiveState = {
            tid: split.tid,
            manifest: split.manifest,
            complete: true,
            updatedAt: Date.now(),
            chunks: new Map(),
        };

        for (const chunk of split.chunks) {
            let byIndex = state.chunks.get(chunk.cid);
            if (!byIndex) {
                byIndex = new Map();
                state.chunks.set(chunk.cid, byIndex);
            }
            byIndex.set(chunk.index, chunk);
        }

        expect2(() => assembleJSON(state)).toEqual(input);
    });

    it('should send split packets only when JSONSplitResult.send is called', async () => {
        const network = createNetwork({ id: 'json-split-send', unordered: false, maxPacketBytes: 512 });
        const received: string[] = [];
        const split = splitJSON(
            { type: 'text' as const, data: { text: uniquePayload(10) } },
            { largeValueBytes: 12, chunkBytes: 20, identityProvider: identityProvider() },
        );

        network.onMessage(packet => {
            received.push(packet);
        });

        expect2(() => received).toEqual([]);
        split.send(network);
        await wait();

        expect2(() => received.length).toEqual(split.chunks.length + 2);
        expect2(() => split.summarize()).toEqual(split.size);
    });

    it('should emit rebuilt GenAI response through JSONTransport', async () => {
        const network = createNetwork({ id: 'json-loopback', unordered: false, maxPacketBytes: 256 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            largeValueBytes: 12,
            chunkBytes: 24,
        });
        const received: any[] = [];

        transport.onMessage(data => {
            received.push(data);
        });

        transport.send({ type: 'text', data: { text: repeat('hello ', 12) } });
        await wait();

        expect2(() => received).toEqual([{ type: 'text', data: { text: repeat('hello ', 12) } }]);
    });

    it('should emit structured JSON transport and network logs', async () => {
        const logs: SocketLogEntry[] = [];
        const logger = { log: (entry: SocketLogEntry) => logs.push(entry) };
        const network = createNetwork({ id: 'json-logged', unordered: false, maxPacketBytes: 256, logger });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            largeValueBytes: 12,
            chunkBytes: 24,
            logger,
        });
        const received: any[] = [];

        transport.onMessage(data => {
            received.push(data);
        });

        transport.send({ type: 'text', data: { text: repeat('hello ', 12) } });
        await wait();

        expect2(() => received.length).toEqual(1);
        expect2(() => logs.some(log => log.location === 'json.send' && log.networkId === 'json-logged')).toEqual(true);
        expect2(() => logs.some(log => log.location === 'json.receive' && log.networkId === 'json-logged')).toEqual(
            true,
        );
        expect2(() => logs.some(log => log.location === 'json.assemble' && log.networkId === 'json-logged')).toEqual(
            true,
        );
        expect2(() => logs.some(log => log.location === 'network.send' && log.networkId === 'json-logged')).toEqual(
            true,
        );
    });

    it('should derive chunkBytes from a known network packet size', async () => {
        const network = createNetwork({ id: 'json-sized', unordered: false, maxPacketBytes: 320 });
        const chunkBytes = calculateJSONTransportChunkBytes(320, 220);
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            envelopeReserveBytes: 220,
            chunkBytes,
            largeValueBytes: 24,
        });
        const received: any[] = [];

        transport.onMessage(data => {
            received.push(data);
        });

        expect2(() => chunkBytes).toEqual(100);
        transport.send({ type: 'text', data: { text: uniquePayload(24) } });
        await wait();

        expect2(() => received).toEqual([{ type: 'text', data: { text: uniquePayload(24) } }]);
    });

    it('should reconstruct out-of-order network packets', async () => {
        const network = createNetwork({ id: 'json-unordered', unordered: true, jitterMs: 2, maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'image'; data: { mimeType: string; inlineData: string } }>(
            network,
            { largeValueBytes: 16, chunkBytes: 32 },
        );
        const received: any[] = [];
        const input = {
            type: 'image' as const,
            data: { mimeType: 'image/png', inlineData: uniquePayload(24) },
        };

        transport.onMessage(data => {
            received.push(data);
        });
        transport.send(input);
        await wait(20);

        expect2(() => received).toEqual([input]);
    });

    it('should emit errors for invalid raw packets and duplicate chunks', async () => {
        const network = createNetwork({ id: 'json-errors', unordered: false, maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network);
        const scopes: string[] = [];

        transport.onError((_error, context) => {
            scopes.push(context.scope);
        });

        network.send('not-json');
        await wait();

        const split = splitJSON(
            { type: 'text' as const, data: { text: 'large enough text' } },
            { largeValueBytes: 4, chunkBytes: 32, identityProvider: identityProvider() },
        );
        const chunk = split.chunks[0];
        network.send(JSON.stringify(chunk));
        network.send(JSON.stringify(chunk));
        await wait();

        expect2(() => scopes).toEqual(['json.parse', 'json.chunk.duplicate']);
    });

    it('should reject a chunk whose data hash does not match', async () => {
        const network = createNetwork({ id: 'json-hash', unordered: false, maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network);
        const scopes: string[] = [];
        const split = splitJSON(
            { type: 'text' as const, data: { text: 'large enough text' } },
            { largeValueBytes: 4, chunkBytes: 32, identityProvider: identityProvider() },
        );

        transport.onError((_error, context) => {
            scopes.push(context.scope);
        });

        network.send(JSON.stringify({ ...split.chunks[0], data: 'tampered' } as JSONTransportPacket));
        await wait();

        expect2(() => scopes).toEqual(['json.chunk.hash']);
    });

    it('should expose pending count and cleanup expired partial messages', async () => {
        const network = createNetwork({ id: 'json-cleanup', unordered: false, maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            partialTtlMs: 1,
        });
        const scopes: string[] = [];
        const split = splitJSON(
            { type: 'text' as const, data: { text: 'large enough text' } },
            { largeValueBytes: 4, chunkBytes: 32, identityProvider: identityProvider() },
        );

        transport.onError((_error, context) => {
            scopes.push(context.scope);
        });

        network.send(JSON.stringify(split.chunks[0]));
        await wait();

        expect2(() => transport.pendingCount).toEqual(1);
        expect2(() => transport.cleanup(Date.now() + 10)).toEqual(1);
        expect2(() => transport.pendingCount).toEqual(0);
        expect2(() => scopes).toEqual(['json.partial.expired']);
    });

    it('should cleanup expired partial messages automatically when configured', async () => {
        const network = createNetwork({ id: 'json-auto-cleanup', unordered: false, maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            partialTtlMs: 1,
            cleanupIntervalMs: 2,
        });
        const scopes: string[] = [];
        const split = splitJSON(
            { type: 'text' as const, data: { text: 'large enough text' } },
            { largeValueBytes: 4, chunkBytes: 32, identityProvider: identityProvider() },
        );

        transport.onError((_error, context) => {
            scopes.push(context.scope);
        });

        network.send(JSON.stringify(split.chunks[0]));
        await wait(20);

        expect2(() => transport.pendingCount).toEqual(0);
        expect2(() => scopes).toEqual(['json.partial.expired']);
        transport.detach();
    });

    it('should validate manifest refs and chunk consistency', async () => {
        const network = createNetwork({ id: 'json-validate', unordered: false, maxPacketBytes: 1024 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network);
        const scopes: string[] = [];
        const split = splitJSON(
            { type: 'text' as const, data: { text: 'large enough text' } },
            { largeValueBytes: 4, chunkBytes: 32, identityProvider: identityProvider() },
        );
        const ref = split.manifest.refs[0];

        transport.onError((_error, context) => {
            scopes.push(context.scope);
        });

        network.send(
            JSON.stringify({
                ...split.manifest,
                tid: 'bad-dup',
                refs: [ref, { ...ref }],
            } as JSONTransportPacket),
        );
        network.send(
            JSON.stringify({
                ...split.manifest,
                tid: 'bad-path',
                refs: [{ ...ref, cid: 'missing-marker' }],
            } as JSONTransportPacket),
        );
        network.send(JSON.stringify({ ...split.manifest, tid: 'bad-chunk', refs: [] } as JSONTransportPacket));
        network.send(JSON.stringify({ ...split.chunks[0], tid: 'bad-chunk' } as JSONTransportPacket));
        network.send(JSON.stringify(split.manifest));
        network.send(JSON.stringify({ ...split.chunks[0], total: split.chunks[0].total + 1 } as JSONTransportPacket));
        network.send(
            JSON.stringify({
                ...split.manifest,
                tid: 'bad-size',
                refs: [{ ...ref, size: ref.size + 1 }],
            } as JSONTransportPacket),
        );
        network.send(JSON.stringify({ ...split.chunks[0], tid: 'bad-size' } as JSONTransportPacket));
        await wait();

        expect2(() => scopes).toEqual([
            'json.ref.duplicate',
            'json.ref.path',
            'json.chunk.ref',
            'json.chunk.total',
            'json.ref.size',
        ]);
    });

    it('should throw when a transport packet is too big', () => {
        const network = createNetwork({ id: 'json-too-big', unordered: false, maxPacketBytes: 64 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            largeValueBytes: 16,
            chunkBytes: 16,
        });

        expect2(() => transport.send({ type: 'text', data: { text: repeat('x', 32) } })).toEqual(
            '1009: message too big',
        );
    });
});

describe('reliable mode', () => {
    it('① should complete a reliable round-trip for a small payload', async () => {
        const aToB = createNetwork({ id: 'rel-small-a2b', maxPacketBytes: 1024 });
        const bToA = createNetwork({ id: 'rel-small-b2a', maxPacketBytes: 1024 });
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(aToB, {
            reliable: { ...shortReliable(), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'text'; data: { text: string } }>(bToA, {
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        const promise = a.send({ type: 'text', data: { text: 'hello' } });
        expect2(() => promise instanceof Promise).toEqual(true);
        await promise;
        await wait();

        expect2(() => received).toEqual([{ type: 'text', data: { text: 'hello' } }]);
    });

    it('① should complete a reliable round-trip for a large chunked payload', async () => {
        const aToB = createNetwork({ id: 'rel-large-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-large-b2a', maxPacketBytes: 512 });
        const a = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(aToB, {
            largeValueBytes: 16,
            chunkBytes: 32,
            reliable: { ...shortReliable(), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(bToA, {
            largeValueBytes: 16,
            chunkBytes: 32,
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        const input = { type: 'image' as const, data: { inlineData: uniquePayload(30) } };
        await a.send(input);
        await wait();

        expect2(() => received).toEqual([input]);
    });

    it('② should recover a lost chunk via NACK by resending only the missing chunk', async () => {
        const aToB = createNetwork({ id: 'rel-nack-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-nack-b2a', maxPacketBytes: 512 });
        let dropOnce = true;
        const droppedAtoB = withDrop(aToB, raw => {
            if (!dropOnce) return false;
            const packet = JSON.parse(raw) as JSONTransportPacket;
            if (packet.type === 'json:chunk' && (packet as any).index === 1) {
                dropOnce = false; // drop only the first occurrence — let the NACK-driven resend through
                return true;
            }
            return false;
        });
        const a = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(droppedAtoB, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable({ resendIntervalMs: 5000 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(bToA, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable({ resendIntervalMs: 5000 }), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));
        const sentOnAtoB: JSONTransportPacket[] = [];
        aToB.onMessage(raw => sentOnAtoB.push(JSON.parse(raw)));

        const input = { type: 'image' as const, data: { inlineData: uniquePayload(6) } };
        await a.send(input);
        await wait(40);

        expect2(() => received).toEqual([input]);
        expect2(() => sentOnAtoB.filter(p => p.type === 'json:manifest').length).toEqual(1);
        expect2(() => sentOnAtoB.filter(p => p.type === 'json:complete').length).toEqual(1);
        expect2(() => sentOnAtoB.filter(p => p.type === 'json:chunk' && (p as any).index === 1).length).toEqual(1);
    });

    it('③ should recover via blind full resend when the entire first attempt is lost', async () => {
        const aToB = createNetwork({ id: 'rel-blind-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-blind-b2a', maxPacketBytes: 512 });
        let firstAttemptDone = false;
        const droppedAtoB = withDrop(aToB, raw => {
            if (firstAttemptDone) return false;
            const packet = JSON.parse(raw) as JSONTransportPacket;
            if (packet.type === 'json:complete') firstAttemptDone = true; // marks the end of attempt #1
            return true; // drop everything belonging to attempt #1
        });
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(droppedAtoB, {
            reliable: { ...shortReliable({ resendIntervalMs: 20, maxAttempts: 6 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'text'; data: { text: string } }>(bToA, {
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        const promise = a.send({ type: 'text', data: { text: 'blind-fallback' } }) as Promise<void>;
        await wait(80);
        await promise;

        expect2(() => received).toEqual([{ type: 'text', data: { text: 'blind-fallback' } }]);
        expect2(() => b.pendingCount).toEqual(0);
    });

    it('④ should terminate both sides as a failure when recovery is impossible', async () => {
        const aToB = createNetwork({ id: 'rel-fail-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-fail-b2a', maxPacketBytes: 512 });
        const droppedAtoB = withDrop(aToB, raw => {
            const packet = JSON.parse(raw) as JSONTransportPacket;
            return packet.type === 'json:chunk' && (packet as any).index === 0; // permanently unreachable chunk
        });
        const a = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(droppedAtoB, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable({ resendIntervalMs: 15, maxAttempts: 3 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(bToA, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable({ nackDebounceMs: 500 }), receiveNetwork: aToB },
        });
        const errorScopesA: string[] = [];
        const errorScopesB: string[] = [];
        a.onError((_e, ctx) => errorScopesA.push(ctx.scope));
        b.onError((_e, ctx) => errorScopesB.push(ctx.scope));
        const receivedB: any[] = [];
        b.onMessage(data => receivedB.push(data));

        let caught: any;
        const send = a.send({ type: 'image', data: { inlineData: uniquePayload(6) } }) as Promise<void>;
        send.catch(e => (caught = e));
        await wait(150);

        expect2(() => receivedB).toEqual([]);
        expect2(() => caught instanceof JSONTransportReliableError).toEqual(true);
        expect2(() => errorScopesA.includes('json.reliable.failed')).toEqual(true);
        expect2(() => errorScopesB.includes('json.error')).toEqual(true);
        expect2(() => b.pendingCount).toEqual(0);
    });

    it('⑤ should converge via re-ack after an ack is lost without duplicating delivery', async () => {
        const aToB = createNetwork({ id: 'rel-ackloss-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-ackloss-b2a', maxPacketBytes: 512 });
        let ackDropped = false;
        const droppedBtoA = withDrop(bToA, raw => {
            const packet = JSON.parse(raw) as JSONTransportPacket;
            if (packet.type === 'json:ack' && !ackDropped) {
                ackDropped = true;
                return true;
            }
            return false;
        });
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(aToB, {
            reliable: { ...shortReliable({ resendIntervalMs: 20, maxAttempts: 6 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'text'; data: { text: string } }>(droppedBtoA, {
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        await a.send({ type: 'text', data: { text: 'ack-loss' } });
        await wait();

        expect2(() => received).toEqual([{ type: 'text', data: { text: 'ack-loss' } }]);
    });

    it('⑥ should not consume retry budget while the network is not open', async () => {
        const aToB = createNetwork({ id: 'rel-tickskip-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-tickskip-b2a', maxPacketBytes: 512 });
        const stateBox: { value?: SocketReadyState } = { value: 'connecting' };
        const toggledAtoB = withReadyState(aToB, stateBox);
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(toggledAtoB, {
            reliable: { ...shortReliable({ resendIntervalMs: 10, maxAttempts: 2 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'text'; data: { text: string } }>(bToA, {
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        const promise = a.send({ type: 'text', data: { text: 'reconnect' } }) as Promise<void>;
        await wait(60); // several ticks pass while not open; none should count toward maxAttempts(2)
        stateBox.value = undefined; // restore real (open) readyState
        await promise;
        await wait();

        expect2(() => received).toEqual([{ type: 'text', data: { text: 'reconnect' } }]);
    });

    it('⑥ should fail send() via deadlineMs even while the network stays permanently non-open', async () => {
        const aToB = createNetwork({ id: 'rel-deadline-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-deadline-b2a', maxPacketBytes: 512 });
        const stateBox: { value?: SocketReadyState } = { value: 'closed' }; // never reopens
        const closedAtoB = withReadyState(aToB, stateBox);
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(closedAtoB, {
            // maxAttempts is large on purpose: readyState never reaches 'open', so attempts never
            // increment — only deadlineMs (not maxAttempts) can end this send().
            reliable: {
                ...shortReliable({ resendIntervalMs: 10, maxAttempts: 1000, deadlineMs: 40 }),
                receiveNetwork: bToA,
            },
        });

        let caught: any;
        const send = a.send({ type: 'text', data: { text: 'never-open' } }) as Promise<void>;
        send.catch(e => (caught = e));
        await wait(90); // several ticks pass while permanently non-open; deadlineMs(40) still trips

        expect2(() => caught instanceof JSONTransportReliableError).toEqual(true);
        expect2(() => (caught as JSONTransportReliableError)?.message.includes('deadline exceeded')).toEqual(true);
    });

    it('⑦ should expire settled memory by TTL, allowing a late duplicate to re-emit', async () => {
        const network = createNetwork({ id: 'rel-settled-ttl', maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            reliable: { nackDebounceMs: 5000, resendIntervalMs: 5000, maxAttempts: 6, settledTtlMs: 20 },
        });
        const received: any[] = [];
        transport.onMessage(data => received.push(data));

        const sendWithTid = (tid: string) => {
            const split = splitJSON(
                { type: 'text' as const, data: { text: tid } },
                { identityProvider: { nextTransportId: () => tid, nextChunkId: () => `${tid}-c` } },
            );
            split.send(network);
        };

        sendWithTid('ttl-tid');
        await wait();
        expect2(() => received.length).toEqual(1);

        // re-deliver the same completed transmission before TTL expiry — absorbed (idempotent, no re-emit)
        sendWithTid('ttl-tid');
        await wait();
        expect2(() => received.length).toEqual(1);

        await wait(30); // exceed settledTtlMs
        transport.cleanup(); // lazy sweep — TTL entry purged

        sendWithTid('ttl-tid');
        await wait();
        expect2(() => received.length).toEqual(2); // memory expired — re-delivery is a fresh transmission
    });

    it('⑦ should bound settled memory size by settledMaxEntries, with a warning', async () => {
        const logs: SocketLogEntry[] = [];
        const logger = { log: (entry: SocketLogEntry) => logs.push(entry) };
        const network = createNetwork({ id: 'rel-settled-max', maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            logger,
            reliable: { nackDebounceMs: 5000, resendIntervalMs: 5000, settledTtlMs: 60000, settledMaxEntries: 2 },
        });
        const received: any[] = [];
        transport.onMessage(data => received.push(data));

        const sendWithTid = (tid: string) => {
            const split = splitJSON(
                { type: 'text' as const, data: { text: tid } },
                { identityProvider: { nextTransportId: () => tid, nextChunkId: () => `${tid}-c` } },
            );
            split.send(network);
        };

        sendWithTid('tid-a');
        await wait();
        sendWithTid('tid-b');
        await wait();
        sendWithTid('tid-c'); // exceeds settledMaxEntries(2) — 'tid-a' settled entry evicted (oldest first), with a warning
        await wait();
        expect2(() => received.length).toEqual(3);
        expect2(() =>
            logs.some(
                log => log.level === 'warn' && log.location === 'json.reliable.evicted' && log.data?.tid === 'tid-a',
            ),
        ).toEqual(true);

        sendWithTid('tid-a'); // evicted — treated as a brand-new transmission (re-emitted)
        await wait();
        expect2(() => received.length).toEqual(4);

        sendWithTid('tid-c'); // still bounded within settled memory — absorbed (no re-emit)
        await wait();
        expect2(() => received.length).toEqual(4);
    });

    it('⑦ should evict expired and failed settled entries before any still-valid ok entry', async () => {
        const logs: SocketLogEntry[] = [];
        const logger = { log: (entry: SocketLogEntry) => logs.push(entry) };
        const network = createNetwork({ id: 'rel-settled-priority', maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            logger,
            reliable: { nackDebounceMs: 5000, resendIntervalMs: 5000, settledTtlMs: 30, settledMaxEntries: 2 },
        });
        const received: any[] = [];
        transport.onMessage(data => received.push(data));

        const sendWithTid = (tid: string) => {
            const split = splitJSON(
                { type: 'text' as const, data: { text: tid } },
                { identityProvider: { nextTransportId: () => tid, nextChunkId: () => `${tid}-c` } },
            );
            split.send(network);
        };
        //! a raw 'json:error' notice settles 'fail' without ever calling getState()/cleanup(), so it can't
        //! prematurely TTL-sweep the stale 'tid-ok' entry below ahead of the size-based eviction under test.
        const sendErrorNotice = (tid: string) => network.send(JSON.stringify({ type: 'json:error', tid, error: 'x' }));

        sendWithTid('tid-ok');
        await wait();
        expect2(() => received.length).toEqual(1);
        await wait(60); // exceeds settledTtlMs(30) — 'tid-ok' entry is now stale but not yet swept

        sendErrorNotice('tid-fail-1');
        await wait();
        sendErrorNotice('tid-fail-2'); // exceeds settledMaxEntries(2) — evicts the *expired* 'tid-ok', not a fail entry
        await wait();

        sendWithTid('tid-ok'); // no longer remembered — treated as a brand-new transmission (re-emitted)
        await wait();
        expect2(() => received.length).toEqual(2);

        // exceeds settledMaxEntries(2) again — evicts the oldest still-fresh *fail* entry ('tid-fail-1'), not the fresh 'ok'
        sendWithTid('tid-fail-1'); // no longer remembered (evicted as a fail entry) — a fresh transmission completes and emits
        await wait();
        expect2(() => received.length).toEqual(3);

        sendWithTid('tid-ok'); // still remembered as 'ok' — absorbed, no re-emit
        await wait();
        expect2(() => received.length).toEqual(3);

        // a still-valid 'ok' entry was never the eviction target — the warn path never fired
        expect2(() => logs.some(log => log.level === 'warn' && log.location === 'json.reliable.evicted')).toEqual(
            false,
        );
    });

    it('⑧ should accept ack/nack packets carrying unknown forward-compat fields', async () => {
        const network = createNetwork({ id: 'rel-forward-compat', maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            reliable: shortReliable(),
        });
        const scopes: string[] = [];
        transport.onError((_e, ctx) => scopes.push(ctx.scope));

        network.send(JSON.stringify({ type: 'json:ack', tid: 'unknown-tid', v: 1, extra: 'field' }));
        network.send(
            JSON.stringify({
                type: 'json:nack',
                tid: 'unknown-tid',
                v: 1,
                manifest: true,
                extraField: { nested: true },
            }),
        );
        await wait();

        // unknown tid + unknown fields — accepted as valid packets and silently ignored (no error)
        expect2(() => scopes).toEqual([]);
    });

    it('⑨ should not raise an unhandled rejection when the send() promise is discarded', async () => {
        const aToB = createNetwork({ id: 'rel-noreject-a2b', maxPacketBytes: 512 });
        const droppedAtoB = withDrop(aToB, () => true); // nothing ever gets through — guarantees exhaustion
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(droppedAtoB, {
            reliable: { ...shortReliable({ resendIntervalMs: 5, maxAttempts: 2 }), receiveNetwork: aToB },
        });

        let unhandled: any;
        const onUnhandledRejection = (reason: any) => (unhandled = reason);
        process.on('unhandledRejection', onUnhandledRejection);

        a.send({ type: 'text', data: { text: 'fire-and-forget' } }); // intentionally not awaited/caught

        await wait(80);
        process.off('unhandledRejection', onUnhandledRejection);

        expect2(() => unhandled).toEqual(undefined);
    });

    it('⑩ should not re-split on resend and must keep the same tid/cid', async () => {
        const aToB = createNetwork({ id: 'rel-nosplit-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-nosplit-b2a', maxPacketBytes: 512 });
        let dropFirstComplete = true;
        const droppedAtoB = withDrop(aToB, raw => {
            const packet = JSON.parse(raw) as JSONTransportPacket;
            if (packet.type === 'json:complete' && dropFirstComplete) {
                dropFirstComplete = false;
                return true; // force a recovery cycle without ever losing manifest/chunks
            }
            return false;
        });
        const a = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(droppedAtoB, {
            largeValueBytes: 8,
            chunkBytes: 12,
            identityProvider: identityProvider(),
            reliable: { ...shortReliable({ resendIntervalMs: 20, maxAttempts: 6 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(bToA, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const sentOnAtoB: JSONTransportPacket[] = [];
        aToB.onMessage(raw => sentOnAtoB.push(JSON.parse(raw)));
        const received: any[] = [];
        b.onMessage(data => received.push(data));

        const input = { type: 'image' as const, data: { inlineData: uniquePayload(6) } };
        await a.send(input);
        await wait(60);

        expect2(() => received).toEqual([input]);
        const tids = new Set(sentOnAtoB.map(p => p.tid));
        expect2(() => tids.size).toEqual(1);
        const chunkCids = new Set(sentOnAtoB.filter(p => p.type === 'json:chunk').map(p => (p as any).cid));
        expect2(() => chunkCids.size).toEqual(1); // single ref — same cid reused across resend, not re-split
    });

    it('⑪ should detect a mismatch when a non-reliable receiver gets a reliable ack', async () => {
        const shared = createNetwork({ id: 'rel-mismatch-1', maxPacketBytes: 512 });
        //! kept unassigned — its constructor subscribes onMessage on `shared`, which is what matters here.
        createJSONTransport<{ type: 'text'; data: { text: string } }>(shared, { reliable: shortReliable() });
        const plain = createJSONTransport<{ type: 'text'; data: { text: string } }>(shared);
        const plainScopes: string[] = [];
        plain.onError((_e, ctx) => plainScopes.push(ctx.scope));

        // non-reliable → reliable. reliable assembles + auto-acks; plain doesn't understand json:ack.
        plain.send({ type: 'text', data: { text: 'plain-to-reliable' } });
        await wait();

        expect2(() => plainScopes.includes('json.reliable.mismatch')).toEqual(true);
    });

    it('⑪ should fail a reliable send() when the non-reliable receiver never acks', async () => {
        const sharedB = createNetwork({ id: 'rel-mismatch-2', maxPacketBytes: 512 });
        //! an unused network just so the reliable sender's onMessage subscription doesn't land on
        //! its own outbound pipe (sharedB) — avoids self-echoing its own ack back to itself.
        const unusedReceive = createNetwork({ id: 'rel-mismatch-2-unused', maxPacketBytes: 512 });
        const reliable = createJSONTransport<{ type: 'text'; data: { text: string } }>(sharedB, {
            reliable: { ...shortReliable({ resendIntervalMs: 20, maxAttempts: 3 }), receiveNetwork: unusedReceive },
        });
        const plain = createJSONTransport<{ type: 'text'; data: { text: string } }>(sharedB);
        const received: any[] = [];
        plain.onMessage(data => received.push(data));

        // reliable → non-reliable. plain never acks, so reliable's send() exhausts its retry budget and
        // fails — the reliable side observes a failure even though the payload was actually delivered.
        let caught: any;
        const send = reliable.send({ type: 'text', data: { text: 'reliable-to-plain' } }) as Promise<void>;
        send.catch(e => (caught = e));
        await wait(120);

        // plain has no reliable-mode dedup memory, so each blind resend re-emits — payload delivery
        // itself isn't blocked by the mismatch, only the sender's own success confirmation is.
        expect2(() => received.length >= 1).toEqual(true);
        expect2(() => received[0]).toEqual({ type: 'text', data: { text: 'reliable-to-plain' } });
        expect2(() => caught instanceof JSONTransportReliableError).toEqual(true);
    });

    it('⑫ should treat a corrupted chunk as missing and recover it via NACK', async () => {
        const aToB = createNetwork({ id: 'rel-corrupt-a2b', maxPacketBytes: 512 });
        const bToA = createNetwork({ id: 'rel-corrupt-b2a', maxPacketBytes: 512 });
        let corruptOnce = true;
        const corruptingAtoB = withCorrupt(aToB, packet => {
            if (corruptOnce && packet.type === 'json:chunk' && packet.index === 0) {
                corruptOnce = false;
                return true;
            }
            return false;
        });
        const a = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(corruptingAtoB, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable({ resendIntervalMs: 5000 }), receiveNetwork: bToA },
        });
        const b = createJSONTransport<{ type: 'image'; data: { inlineData: string } }>(bToA, {
            largeValueBytes: 8,
            chunkBytes: 12,
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });
        const received: any[] = [];
        const errorScopesB: string[] = [];
        b.onMessage(data => received.push(data));
        b.onError((_e, ctx) => errorScopesB.push(ctx.scope));

        const input = { type: 'image' as const, data: { inlineData: uniquePayload(6) } };
        await a.send(input);
        await wait(40);

        expect2(() => received).toEqual([input]);
        expect2(() => errorScopesB.includes('json.chunk.hash')).toEqual(true);
    });

    it('should settle a TTL-expired partial buffer as failed and never revive it on a delayed resend', async () => {
        const network = createNetwork({ id: 'rel-partial-ttl-fail', maxPacketBytes: 512 });
        const transport = createJSONTransport<{ type: 'text'; data: { text: string } }>(network, {
            reliable: { nackDebounceMs: 5000, resendIntervalMs: 5000, maxAttempts: 6, settledTtlMs: 60000 },
        });
        const received: any[] = [];
        const errorScopes: string[] = [];
        const sentAcks: string[] = [];
        transport.onMessage(data => received.push(data));
        transport.onError((_e, ctx) => errorScopes.push(ctx.scope));
        network.onMessage(raw => {
            const packet = JSON.parse(raw) as JSONTransportPacket;
            if (packet.type === 'json:ack') sentAcks.push(packet.tid);
        });

        const split = splitJSON(
            { type: 'text' as const, data: { text: 'partial-fail' } },
            {
                identityProvider: {
                    nextTransportId: () => 'partial-fail-tid',
                    nextChunkId: () => 'partial-fail-tid-c',
                },
            },
        );
        network.send(JSON.stringify(split.manifest)); // manifest only — leaves an incomplete partial buffer
        await wait();
        expect2(() => received.length).toEqual(0);

        expect2(() => transport.cleanup(Date.now() + 10 * 60 * 1000)).toEqual(1); // force TTL expiry
        expect2(() => errorScopes.includes('json.partial.expired')).toEqual(true);

        // a delayed, otherwise-complete retransmission for the same tid arrives after the fail was settled
        split.send(network);
        await wait();

        expect2(() => received.length).toEqual(0); // no silent revival — the earlier fail notice stays final
        expect2(() => sentAcks.includes('partial-fail-tid')).toEqual(false); // settled-fail — never acked
    });

    it('should match a direct or peer-republished reliable scope but not an unrelated one', async () => {
        expect2(() => isJSONReliableScope(JSON_RELIABLE_SCOPE.mismatch)).toEqual(true);
        expect2(() => isJSONReliableScope(`peer.transport.${JSON_RELIABLE_SCOPE.mismatch}`)).toEqual(true);
        expect2(() => isJSONReliableScope('json.partial.expired')).toEqual(false);
    });

    it('should deliver a typed JSONTransportReliableError through onReliableError on the direct transport path', async () => {
        const aToB = createNetwork({ id: 'rel-onReliableError-a2b', maxPacketBytes: 512 });
        const droppedAtoB = withDrop(aToB, () => true); // nothing ever gets through — guarantees exhaustion
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(droppedAtoB, {
            reliable: { ...shortReliable({ resendIntervalMs: 5, maxAttempts: 2 }), receiveNetwork: aToB },
        });

        const received: { error: JSONTransportReliableError; context: SocketErrorContext }[] = [];
        onReliableError(a, (error, context) => received.push({ error, context }));

        await (a.send({ type: 'text', data: { text: 'typed-error' } }) as Promise<void>).catch(() => undefined);
        await wait(60);

        expect2(() => received.length).toEqual(1);
        expect2(() => received[0].error instanceof JSONTransportReliableError).toEqual(true);
        expect2(() => received[0].context.scope).toEqual(JSON_RELIABLE_SCOPE.failed);
    });

    it('should not invoke onReliableError for a non-reliable-scoped error on the same transport', async () => {
        const aToB = createNetwork({ id: 'rel-onReliableError-filter', maxPacketBytes: 512 });
        const a = createJSONTransport<{ type: 'text'; data: { text: string } }>(aToB, {
            reliable: { ...shortReliable(), receiveNetwork: aToB },
        });

        const received: JSONTransportReliableError[] = [];
        onReliableError(a, error => received.push(error));

        aToB.send('not-json'); // triggers a 'json.parse' error — unrelated to reliable-mode failures
        await wait();

        expect2(() => received.length).toEqual(0);
    });
});
