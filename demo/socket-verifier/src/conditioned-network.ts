/**
 * outbound-only `NetworkSupportable` decorator: latency/jitter/reorder/drop/corrupt/1009 guard (02-design.md).
 * Condition is read via `getCondition()` on every send so UI sliders apply immediately.
 */
import type {
    NetworkMessageHandler,
    NetworkSupportable,
    SocketErrorHandler,
    SocketNetworkOptions,
    SocketReadyState,
    SocketUnsubscribe,
} from '@socket/types';
import type { NetworkTapEvent, VerifierCondition } from './types';

/** minimal shape of a `json:chunk` transport packet (see @socket/transport) */
interface ChunkPacket {
    type: 'json:chunk';
    tid: string;
    cid: string;
    index: number;
    total: number;
    data: string;
    hash: string;
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** parse a raw outbound frame as a `json:chunk` packet; anything else (or invalid JSON) passes through untouched */
const parseChunkPacket = (raw: string): ChunkPacket | undefined => {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.type === 'json:chunk') return parsed as ChunkPacket;
    } catch {
        // not JSON — leave untouched
    }
    return undefined;
};

/** flip the leading byte of the chunk payload; `hash` is left untouched so the receiver's hash check fires */
const corruptChunkData = (data: string): string => {
    if (!data) return 'X';
    const swapped = data[0] === 'X' ? 'Y' : 'X';
    return swapped + data.slice(1);
};

/** `NetworkSupportable` decorator applying verifier conditions to outbound `send()` only */
class ConditionedNetwork implements NetworkSupportable {
    public constructor(
        private readonly source: NetworkSupportable,
        private readonly getCondition: () => VerifierCondition,
        private readonly onTap?: (event: NetworkTapEvent) => void,
    ) {}

    public get readyState(): SocketReadyState {
        return this.source.readyState;
    }

    public ready(): Promise<void> {
        return this.source.ready?.() ?? Promise.resolve();
    }

    public onOpen(handler: () => void): SocketUnsubscribe {
        return this.source.onOpen?.(handler) ?? (() => undefined);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        return this.source.onMessage(handler);
    }

    public configure(options: SocketNetworkOptions): void {
        this.source.configure?.(options);
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        return this.source.onError(handler);
    }

    public close(code?: number, reason?: string): void {
        this.source.close(code, reason);
    }

    public send(data: string): void {
        const condition = this.getCondition();

        const bytes = byteLength(data);
        if (bytes > condition.maxPacketBytes) throw new Error(`1009: message too big`);

        if (condition.dropRate > 0 && Math.random() < condition.dropRate) {
            this.onTap?.({ kind: 'drop', at: Date.now(), raw: data, meta: { bytes } });
            return;
        }

        let frame = data;
        let chunk = parseChunkPacket(frame);
        if (chunk && condition.corruptRate > 0 && Math.random() < condition.corruptRate) {
            chunk = { ...chunk, data: corruptChunkData(chunk.data) };
            frame = JSON.stringify(chunk);
            this.onTap?.({
                kind: 'corrupt',
                at: Date.now(),
                raw: frame,
                meta: { tid: chunk.tid, cid: chunk.cid, index: chunk.index, total: chunk.total },
            });
        }

        if (chunk) {
            this.onTap?.({
                kind: 'chunk-out',
                at: Date.now(),
                raw: frame,
                meta: {
                    tid: chunk.tid,
                    cid: chunk.cid,
                    index: chunk.index,
                    total: chunk.total,
                    bytes: byteLength(frame),
                },
            });
        }

        const delayMs = this.nextDelayMs(condition);
        if (delayMs <= 0) {
            this.source.send(frame);
            return;
        }
        setTimeout(() => this.source.send(frame), delayMs);
    }

    /** ordered: base latency only (stable delivery order). unordered: latency + random jitter (may reorder) */
    private nextDelayMs(condition: VerifierCondition): number {
        if (!condition.unordered || condition.jitterMs <= 0) return condition.latencyMs;
        return condition.latencyMs + Math.random() * condition.jitterMs;
    }
}

/** wrap `source` so outbound `send()` is subject to `getCondition()`; inbound is untouched */
export const createConditionedNetwork = (
    source: NetworkSupportable,
    getCondition: () => VerifierCondition,
    onTap?: (event: NetworkTapEvent) => void,
): NetworkSupportable => new ConditionedNetwork(source, getCondition, onTap);
