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
    JSONReceiveState,
    SocketLogEntry,
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
