/**
 * `buffer/network.ts`
 * - Network transport adapters and diagnostics for GenAI stream events.
 *
 * @origin eureka-agents-api / src/lib/buffer/network.ts
 *
 * GenAIStreamConsumer emits typed events, while NetworkSupportable only accepts
 * raw strings and may enforce a packet-size limit. This adapter keeps those
 * concerns separate by sending stream events through JSONTransport.
 */
import {
    calculateJSONTransportChunkBytes,
    createJSONTransport,
    JSONTransportOptions,
    JSONTransportSupportable,
} from '../socket/transport';
import { NetworkSupportable, SocketErrorHandler, SocketUnsubscribe } from '../socket/types';
import { GenAIStreamChunkEvent, GenAIStreamConsumer, GenAIStreamEvent, GenAIStreamFlushEvent } from './stream';

export interface GenAIStreamNetworkPacket {
    /** packet discriminator used after JSONTransport reassembly */
    type: 'genai:stream';
    /** compact logical stream/session id for multiplexing over one network */
    sid?: string;
    /** monotonically increasing event sequence assigned by the sender */
    seq: number;
    /** sender-side timestamp in epoch milliseconds */
    sentAt: number;
    /** original or wire-compacted GenAI stream event */
    event: GenAIStreamEvent;
    /** optional wire-compaction metadata used by restoreStreamEvent() */
    compact?: GenAIStreamNetworkCompactMeta;
}

export interface GenAIStreamNetworkCompactMeta {
    /** chunk data was removed because it can be reconstructed from flush.data */
    flushChunksData?: 'fromFlushData';
}

export interface GenAIStreamNetworkOptions {
    /** optional stream/session id carried with every network packet */
    streamId?: string;
    /** known raw network packet limit; used to derive JSONTransport chunkBytes */
    maxPacketBytes?: number;
    /** JSONTransport chunking/reassembly options */
    jsonTransport?: JSONTransportOptions;
    /** wait for network.ready() before each event send; defaults to true */
    waitReady?: boolean;
    /** observe errors thrown by the receiver-side consumer */
    onConsumerError?: SocketErrorHandler;
    /** observe every accepted stream network packet before forwarding its event */
    onPacket?: (packet: GenAIStreamNetworkPacket) => void;
    /** deliver stream packets by seq order; useful for unordered networks */
    reorder?: boolean;
    /** remove duplicated flush chunks[].data on the wire and restore it on receive */
    compactFlush?: boolean;
}

export interface GenAIStreamNetworkConsumerHandle {
    consumer: GenAIStreamConsumer;
    transport: JSONTransportSupportable<GenAIStreamNetworkPacket>;
    detach(): void;
}

export interface GenAIStreamNetworkReceiver {
    transport: JSONTransportSupportable<GenAIStreamNetworkPacket>;
    detach(): void;
}

// eslint-disable-next-line prettier/prettier
const STREAM_EVENT_SPLIT_PATHS = ['/event/data', '/event/chunks/*/data', '/event/error/message', '/event/error/stack'];

export const asGenAIStreamNetworkTransportOptions = (
    options?: GenAIStreamNetworkOptions,
): JSONTransportOptions | undefined => {
    const jsonTransport = options?.jsonTransport ?? {};
    const chunkBytes =
        jsonTransport.chunkBytes ??
        (options?.maxPacketBytes
            ? calculateJSONTransportChunkBytes(options.maxPacketBytes, jsonTransport.envelopeReserveBytes)
            : undefined);

    return {
        ...jsonTransport,
        chunkBytes,
        // eslint-disable-next-line prettier/prettier
        preferredSplitPaths: [...STREAM_EVENT_SPLIT_PATHS, ...(jsonTransport.preferredSplitPaths ?? [])],
    };
};

/**
 * Create a GenAIStreamConsumer that serializes stream events and sends them over
 * NetworkSupportable via JSONTransport.
 *
 * The returned consumer preserves the normal GenAIStreamConsumer contract. The
 * only network-specific behavior is packet wrapping, optional flush compaction,
 * and JSONTransport splitting for large string payloads.
 */
export const createGenAIStreamNetworkConsumer = (
    network: NetworkSupportable,
    options?: GenAIStreamNetworkOptions,
): GenAIStreamNetworkConsumerHandle => {
    const transport = createJSONTransport<GenAIStreamNetworkPacket>(
        network,
        asGenAIStreamNetworkTransportOptions(options),
    );
    const waitReady = options?.waitReady ?? true;
    let seq = 0;

    const consumer: GenAIStreamConsumer = async event => {
        if (waitReady && network.ready) await network.ready();
        const compacted = options?.compactFlush ? compactStreamEvent(event) : { event };
        transport.send({
            type: 'genai:stream',
            sid: options?.streamId,
            seq: seq++,
            sentAt: Date.now(),
            ...compacted,
        });
    };

    return {
        consumer,
        transport,
        detach: () => transport.detach(),
    };
};

/**
 * Receive GenAI stream event packets from a NetworkSupportable and forward the
 * rebuilt events to a GenAIStreamConsumer.
 *
 * When reorder is enabled, packets are held until their seq number can be
 * delivered contiguously. This is intentionally stream-local; callers should set
 * streamId when multiplexing multiple streams over one network. On the wire,
 * that stream id is carried as the compact `sid` field.
 */
export const createGenAIStreamNetworkReceiver = (
    network: NetworkSupportable,
    consumer: GenAIStreamConsumer,
    options?: GenAIStreamNetworkOptions,
): GenAIStreamNetworkReceiver => {
    const transport = createJSONTransport<GenAIStreamNetworkPacket>(
        network,
        asGenAIStreamNetworkTransportOptions(options),
    );
    // Reordering is deliberately simple: it waits for contiguous seq numbers
    // from zero. A higher-level timeout policy should own missing packets.
    let nextSeq = 0;
    const pending = new Map<number, GenAIStreamNetworkPacket>();
    const deliver = (packet: GenAIStreamNetworkPacket) => {
        const event = restoreStreamEvent(packet);
        void Promise.resolve(consumer(event)).catch(error => {
            options?.onConsumerError?.(error, { scope: 'genai.stream.consumer', network });
        });
    };
    const accept = (packet: GenAIStreamNetworkPacket) => {
        options?.onPacket?.(packet);
        if (!options?.reorder) {
            deliver(packet);
            return;
        }
        pending.set(packet.seq, packet);
        while (pending.has(nextSeq)) {
            const ordered = pending.get(nextSeq)!;
            pending.delete(nextSeq++);
            deliver(ordered);
        }
    };

    transport.onMessage(packet => {
        if (packet?.type !== 'genai:stream') return;
        if (options?.streamId && packet.sid !== options.streamId) return;
        accept(packet);
    });
    return {
        transport,
        detach: () => transport.detach(),
    };
};

/** subscribe to JSONTransport/network errors from a stream network handle */
export const onGenAIStreamNetworkError = (
    handle: GenAIStreamNetworkConsumerHandle | GenAIStreamNetworkReceiver,
    handler: SocketErrorHandler,
): SocketUnsubscribe => handle.transport.onError(handler);

export const compactStreamEvent = (
    event: GenAIStreamEvent,
): { event: GenAIStreamEvent; compact?: GenAIStreamNetworkCompactMeta } => {
    if (event.type !== 'flush' || !canCompactFlushEvent(event)) return { event };
    return {
        event: {
            ...event,
            chunks: event.chunks.map(chunk => {
                const { data: _data, ...rest } = chunk;
                return rest as GenAIStreamChunkEvent;
            }),
        },
        compact: { flushChunksData: 'fromFlushData' },
    };
};

/**
 * Restore a network packet into the public GenAIStreamEvent shape expected by
 * downstream consumers.
 */
export const restoreStreamEvent = (packet: GenAIStreamNetworkPacket): GenAIStreamEvent => {
    const event = packet.event;
    if (event.type !== 'flush' || packet.compact?.flushChunksData !== 'fromFlushData') return event;
    let offset = 0;
    return {
        ...event,
        chunks: event.chunks.map(chunk => {
            const chars = chunk.chars ?? 0;
            const data = event.data.substring(offset, offset + chars);
            offset += chars;
            return { ...chunk, data };
        }),
    };
};

/**
 * Flush events normally carry both joined data and per-chunk data. Compacting is
 * safe only when chunk data is exactly contiguous within flush.data.
 */
const canCompactFlushEvent = (event: GenAIStreamFlushEvent): boolean => {
    let offset = 0;
    for (const chunk of event.chunks) {
        const chars = chunk.chars ?? chunk.data.length;
        if (event.data.substring(offset, offset + chars) !== chunk.data) return false;
        offset += chars;
    }
    return offset === event.data.length;
};
