/**
 * `buffer/network.spec.ts`
 * - GenAI stream network adapter and diagnostic loop tests.
 *
 * @origin eureka-agents-api / src/lib/buffer/network.spec.ts
 */
import { expect2 } from '../cores/index.spec';
import { createNetwork } from '../socket/socket';
import { GenAIStreamEvent } from './stream';
import {
    asGenAIStreamNetworkTransportOptions,
    compactStreamEvent,
    createGenAIStreamNetworkConsumer,
    createGenAIStreamNetworkReceiver,
    restoreStreamEvent,
} from './network';
import { runGenAIStreamNetworkLoop } from './testing';

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const repeat = (value: string, count: number) => new Array(count + 1).join(value);
const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

describe('GenAI stream network adapter', () => {
    /*
     * These tests intentionally exercise both the public adapter API and the
     * diagnostic loop helper. NetworkSupportable only transports raw strings, so
     * every assertion here protects the JSONTransport boundary.
     */
    it('sends stream events as JSON strings over NetworkSupportable', async () => {
        const network = createNetwork({ id: 'stream-network-basic', maxPacketBytes: 512 });
        const received: GenAIStreamEvent[] = [];
        const receiver = createGenAIStreamNetworkReceiver(network, event => {
            received.push(event);
        });
        const sender = createGenAIStreamNetworkConsumer(network, { streamId: 'stream-1', maxPacketBytes: 512 });

        await sender.consumer({
            type: 'progress',
            progress: {
                loadedChars: 5,
                loadedBytes: 5,
                percent: 50,
                bufferPercent: 50,
                estimated: true,
            },
        });
        await sender.consumer({
            type: 'eof',
            progress: {
                loadedChars: 10,
                loadedBytes: 10,
                percent: 100,
                bufferPercent: 100,
                estimated: true,
            },
        });
        await wait();

        expect2(() => received.map(event => event.type)).toEqual(['progress', 'eof']);
        expect2(() => (received[0] as any).progress.bufferPercent).toEqual(50);
        expect2(() => (received[1] as any).progress.percent).toEqual(100);

        sender.detach();
        receiver.detach();
    });

    it('splits large stream event strings to stay under a network packet limit', async () => {
        const network = createNetwork({ id: 'stream-network-large', maxPacketBytes: 1024 });
        const rawPackets: string[] = [];
        const received: GenAIStreamEvent[] = [];
        network.onMessage(packet => rawPackets.push(packet));

        const receiver = createGenAIStreamNetworkReceiver(
            network,
            event => {
                received.push(event);
            },
            { maxPacketBytes: 1024, jsonTransport: { largeValueBytes: 32 } },
        );
        const sender = createGenAIStreamNetworkConsumer(network, {
            streamId: 'stream-large',
            maxPacketBytes: 1024,
            jsonTransport: { largeValueBytes: 32 },
        });
        const data = repeat('large-payload-', 40);

        await sender.consumer({
            type: 'flush',
            data,
            chunks: [{ type: 'chunk', data, chars: data.length, bytes: byteLength(data) }],
            count: 1,
            chars: data.length,
            bytes: byteLength(data),
            progress: {
                loadedChars: data.length,
                loadedBytes: byteLength(data),
                bufferPercent: 100,
                estimated: true,
            },
        });
        await wait(30);

        const flush = received[0] as any;
        expect2(() => flush.type).toEqual('flush');
        expect2(() => flush.data).toEqual(data);
        expect2(() => flush.chunks[0].data).toEqual(data);
        expect2(() => rawPackets.some(packet => JSON.parse(packet).type === 'json:chunk')).toEqual(true);
        expect2(() => rawPackets.every(packet => byteLength(packet) <= 1024)).toEqual(true);

        sender.detach();
        receiver.detach();
    });

    it('compacts duplicated flush chunk data on the wire and restores it for consumers', async () => {
        const network = createNetwork({ id: 'stream-network-compact', maxPacketBytes: 2048 });
        const packets: any[] = [];
        const received: GenAIStreamEvent[] = [];
        network.onMessage(packet => {
            const parsed = JSON.parse(packet);
            if (parsed.type === 'json:manifest') packets.push(parsed);
        });
        const receiver = createGenAIStreamNetworkReceiver(
            network,
            event => {
                received.push(event);
            },
            { maxPacketBytes: 2048 },
        );
        const sender = createGenAIStreamNetworkConsumer(network, {
            streamId: 'compact-stream',
            maxPacketBytes: 2048,
            compactFlush: true,
        });

        await sender.consumer({
            type: 'flush',
            data: 'abcdef',
            chunks: [
                { type: 'chunk', data: 'abc', chars: 3, bytes: 3 },
                { type: 'chunk', data: 'def', chars: 3, bytes: 3 },
            ],
            count: 2,
            chars: 6,
            bytes: 6,
            progress: { loadedChars: 6, loadedBytes: 6, bufferPercent: 100, estimated: true },
        });
        await wait();

        const wireEvent = packets[0].root.event;
        const flush = received[0] as any;
        expect2(() => packets[0].root.compact).toEqual({ flushChunksData: 'fromFlushData' });
        expect2(() => wireEvent.chunks.map((chunk: any) => chunk.data)).toEqual([undefined, undefined]);
        expect2(() => flush.data).toEqual('abcdef');
        expect2(() => flush.chunks.map((chunk: any) => chunk.data)).toEqual(['abc', 'def']);

        sender.detach();
        receiver.detach();
    });

    it('leaves non-contiguous flush chunk data uncompressed', () => {
        const compacted = compactStreamEvent({
            type: 'flush',
            data: 'abcdef',
            chunks: [
                { type: 'chunk', data: 'abc', chars: 3, bytes: 3 },
                { type: 'chunk', data: 'xxx', chars: 3, bytes: 3 },
            ],
            count: 2,
            chars: 6,
            bytes: 6,
            progress: { loadedChars: 6, loadedBytes: 6, bufferPercent: 100, estimated: true },
        });

        expect2(() => compacted.compact).toEqual(undefined);
        expect2(() => (compacted.event as any).chunks.map((chunk: any) => chunk.data)).toEqual(['abc', 'xxx']);
    });

    it('restores compact flush events from packet metadata', () => {
        const restored = restoreStreamEvent({
            type: 'genai:stream',
            seq: 0,
            sentAt: 0,
            compact: { flushChunksData: 'fromFlushData' },
            event: {
                type: 'flush',
                data: 'abcdef',
                chunks: [{ type: 'chunk', chars: 3, bytes: 3 } as any, { type: 'chunk', chars: 3, bytes: 3 } as any],
                count: 2,
                chars: 6,
                bytes: 6,
                progress: { loadedChars: 6, loadedBytes: 6, bufferPercent: 100, estimated: true },
            },
        });

        expect2(() => (restored as any).chunks.map((chunk: any) => chunk.data)).toEqual(['abc', 'def']);
    });

    it('derives JSON transport chunk size from maxPacketBytes', () => {
        const options = asGenAIStreamNetworkTransportOptions({
            maxPacketBytes: 320,
            jsonTransport: { envelopeReserveBytes: 220 },
        });

        expect2(() => options?.chunkBytes).toEqual(100);
        expect2(() => options?.preferredSplitPaths?.includes('/event/data')).toEqual(true);
    });

    it('reports receiver consumer errors without leaking unhandled rejections', async () => {
        const network = createNetwork({ id: 'stream-network-consumer-error', maxPacketBytes: 512 });
        const scopes: string[] = [];
        const receiver = createGenAIStreamNetworkReceiver(
            network,
            async () => {
                throw new Error('receiver failed');
            },
            {
                onConsumerError: (_error, context) => {
                    scopes.push(context.scope);
                },
            },
        );
        const sender = createGenAIStreamNetworkConsumer(network, { maxPacketBytes: 512 });

        await sender.consumer({
            type: 'start',
        });
        await wait();

        expect2(() => scopes).toEqual(['genai.stream.consumer']);

        sender.detach();
        receiver.detach();
    });

    it('filters received stream packets by streamId and exposes packet metadata', async () => {
        const network = createNetwork({ id: 'stream-network-filter', maxPacketBytes: 1024 });
        const received: GenAIStreamEvent[] = [];
        const packets: Array<{ sid?: string; seq: number }> = [];
        const receiver = createGenAIStreamNetworkReceiver(
            network,
            event => {
                received.push(event);
            },
            {
                streamId: 'target-stream',
                maxPacketBytes: 1024,
                onPacket: packet => {
                    packets.push({ sid: packet.sid, seq: packet.seq });
                },
            },
        );
        const ignoredSender = createGenAIStreamNetworkConsumer(network, {
            streamId: 'other-stream',
            maxPacketBytes: 1024,
        });
        const targetSender = createGenAIStreamNetworkConsumer(network, {
            streamId: 'target-stream',
            maxPacketBytes: 1024,
        });

        await ignoredSender.consumer({ type: 'start' });
        await targetSender.consumer({ type: 'start' });
        await targetSender.consumer({
            type: 'eof',
            progress: { loadedChars: 0, loadedBytes: 0, percent: 100, bufferPercent: 100, estimated: true },
        });
        await wait();

        expect2(() => received.map(event => event.type)).toEqual(['start', 'eof']);
        expect2(() => packets).toEqual([
            { sid: 'target-stream', seq: 0 },
            { sid: 'target-stream', seq: 1 },
        ]);

        ignoredSender.detach();
        targetSender.detach();
        receiver.detach();
    });

    it('runs a GenAIStreamBuffer through a network consumer/receiver loop', async () => {
        const result = await runGenAIStreamNetworkLoop({
            id: 'stream-buffer-loop',
            tokens: ['a', 'b', 'c'],
            bufferOptions: {
                flushStrategy: 'size',
                bufferSize: 2,
                meta: { estimate: { totalChars: 6, estimated: false, source: 'loop-test' } },
            },
            networkOptions: { maxPacketBytes: 4096 },
            streamNetwork: { streamId: 'buffer-loop', maxPacketBytes: 4096 },
        });

        expect2(() => result.events.map(event => event.type)).toEqual(['start', 'flush', 'flush', 'eof']);
        expect2(() => result.events.filter(event => event.type === 'flush').map((event: any) => event.data)).toEqual([
            'ab',
            'c',
        ]);
        expect2(() =>
            result.events.filter(event => event.type === 'flush').map((event: any) => event.progress),
        ).toEqual([
            expect.objectContaining({ percent: 33, bufferPercent: 100, source: 'flush' }),
            expect.objectContaining({ percent: 50, bufferPercent: 100, source: 'flush' }),
        ]);
        expect2(() => (result.events[result.events.length - 1] as any).progress.percent).toEqual(100);
        expect2(() => result.snapshot.closed).toEqual(true);
        expect2(() => result.metrics.events).toEqual(4);
        expect2(() => result.metrics.packets > 0).toEqual(true);
    });

    it('runs a buffered large payload loop while respecting packet limits', async () => {
        const text = repeat('payload-', 80);
        const result = await runGenAIStreamNetworkLoop({
            id: 'stream-buffer-large-loop',
            tokens: [text],
            bufferOptions: {
                flushStrategy: 'size',
                bufferSize: 1,
            },
            networkOptions: { maxPacketBytes: 4096 },
            streamNetwork: {
                streamId: 'buffer-large-loop',
                maxPacketBytes: 4096,
                jsonTransport: { largeValueBytes: 32 },
            },
        });

        const flush = result.events.find(event => event.type === 'flush') as any;
        expect2(() => flush.data).toEqual(text);
        expect2(() => flush.progress.bufferPercent).toEqual(100);
        expect2(() => result.rawPackets.some(packet => JSON.parse(packet).type === 'json:chunk')).toEqual(true);
        expect2(() => result.rawPackets.every(packet => byteLength(packet) <= 4096)).toEqual(true);
        expect2(() => result.metrics.chunkPackets > 0).toEqual(true);
        expect2(() => result.metrics.maxPacketBytes <= 4096).toEqual(true);
    });

    it('runs a compact buffered payload loop with lower wire byte usage', async () => {
        const tokens = [repeat('compact-', 40), repeat('payload-', 40)];
        const base = {
            tokens,
            bufferOptions: {
                flushStrategy: 'size' as const,
                bufferSize: 2,
            },
            networkOptions: { maxPacketBytes: 4096 },
            settleMs: 30,
        };
        const normal = await runGenAIStreamNetworkLoop({
            id: 'stream-buffer-normal-size-loop',
            ...base,
            streamNetwork: { streamId: 'normal-size-loop', maxPacketBytes: 4096 },
        });
        const compact = await runGenAIStreamNetworkLoop({
            id: 'stream-buffer-compact-size-loop',
            ...base,
            streamNetwork: { streamId: 'compact-size-loop', maxPacketBytes: 4096, compactFlush: true },
        });

        const flush = compact.events.find(event => event.type === 'flush') as any;
        expect2(() => flush.chunks.map((chunk: any) => chunk.data)).toEqual(tokens);
        expect2(() => compact.metrics.packetBytes < normal.metrics.packetBytes).toEqual(true);
    });

    it('runs an unordered buffered network loop with seq reordering enabled', async () => {
        const result = await runGenAIStreamNetworkLoop({
            id: 'stream-buffer-unordered-loop',
            tokens: ['a', 'b', 'c', 'd'],
            bufferOptions: {
                flushStrategy: 'size',
                bufferSize: 1,
            },
            networkOptions: {
                maxPacketBytes: 4096,
                unordered: true,
                jitterMs: 8,
            },
            streamNetwork: {
                streamId: 'unordered-loop',
                maxPacketBytes: 4096,
                reorder: true,
            },
            settleMs: 80,
        });

        expect2(() => result.events.map(event => event.type)).toEqual([
            'start',
            'flush',
            'flush',
            'flush',
            'flush',
            'eof',
        ]);
        expect2(() => result.events.filter(event => event.type === 'flush').map((event: any) => event.data)).toEqual([
            'a',
            'b',
            'c',
            'd',
        ]);
    });
});
