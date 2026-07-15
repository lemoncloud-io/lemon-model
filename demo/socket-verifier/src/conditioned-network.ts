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
import type { DropFilter, NetworkTapEvent, VerifierCondition } from './types';

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

/** `NetworkSupportable` plus the deterministic force-drop control the demo's presets arm */
export interface ConditionedNetwork extends NetworkSupportable {
    /** deterministically drop the next `count` outbound frames matching the current dropFilter */
    armForceDrop(count: number): void;
}

/** does an outbound frame fall under the current dropFilter? */
const matchesDropFilter = (raw: string, chunk: ChunkPacket | undefined, filter: DropFilter): boolean => {
    if (filter === 'chunk') return chunk !== undefined;
    if (filter === 'ack') return raw.includes('"type":"json:ack"') || raw.includes('"type":"json:nack"');
    return true;
};

/** `NetworkSupportable` decorator applying verifier conditions to outbound `send()` only */
class ConditionedNetworkImpl implements ConditionedNetwork {
    /** remaining count of matching frames to drop deterministically, ahead of any probabilistic dropRate */
    private forceDropRemaining = 0;

    public constructor(
        private readonly source: NetworkSupportable,
        private readonly getCondition: () => VerifierCondition,
        private readonly onTap?: (event: NetworkTapEvent) => void,
    ) {}

    public armForceDrop(count: number): void {
        this.forceDropRemaining = Math.max(0, count);
    }

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

        let chunk = parseChunkPacket(data);
        const filter = condition.dropFilter ?? 'all';
        const targeted = matchesDropFilter(data, chunk, filter);

        // deterministic forced drop wins over probabilistic dropRate so presets are repeatable
        if (targeted && this.forceDropRemaining > 0) {
            this.forceDropRemaining -= 1;
            this.emitDrop(data, chunk, bytes);
            return;
        }
        if (targeted && condition.dropRate > 0 && Math.random() < condition.dropRate) {
            this.emitDrop(data, chunk, bytes);
            return;
        }

        let frame = data;
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

    /** emit a drop tap, carrying chunk identifiers when the dropped frame is a json:chunk */
    private emitDrop(raw: string, chunk: ChunkPacket | undefined, bytes: number): void {
        const meta = chunk
            ? { tid: chunk.tid, cid: chunk.cid, index: chunk.index, total: chunk.total, bytes }
            : { bytes };
        this.onTap?.({ kind: 'drop', at: Date.now(), raw, meta });
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
): ConditionedNetwork => new ConditionedNetworkImpl(source, getCondition, onTap);
