/**
 * `logtrace/logtrace.ts`
 * - one-way (server -> client) realtime log stream over one shared WebSocket.
 * - contracts + reporter(batching) + consumer(ring buffer) live in one file since
 *   both ends share the wire envelope/batch codec (see SPEC.md).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { NetworkSupportable, SocketMessage, SocketUnsubscribe } from '../socket/types';
import { createFilteredNetwork } from '../socket/websocket';

/** log severity - same 4 levels as SocketLogLevel */
export type LogTraceLevel = 'debug' | 'info' | 'warn' | 'error';

/** single log entry - the minimal unit crossing the wire */
export interface LogTraceEntry {
    /** log severity */
    level: LogTraceLevel;
    /** epoch timestamp in milliseconds */
    ts: number;
    /** human-readable message */
    message: string;
    /** structured extra data (optional) */
    json?: Record<string, any>;
    /** monotonic sequence within a source - ordering/loss observation. issued only past the reporter minLevel gate */
    seq: number;
    /** sender identity - carried on the batch over the wire; filled by the consumer when storing */
    source?: string;
    /** true when json was dropped or message was cut by the size budget */
    truncated?: boolean;
}

/** batch payload carried in SocketMessage.data */
export interface LogTraceBatch {
    /** batch entries (reporter emit order) */
    entries: LogTraceEntry[];
    /** sender identity - unique per reporter (required). consumer dedup/loss key */
    source: string;
}

/** server-side send path injection (Ports & Adapters). a rejected Promise is wired into onError */
export type LogTraceSink = (message: SocketMessage<LogTraceBatch>) => void | Promise<void>;

export interface LogTraceReporterOptions {
    /** envelope type (default 'log:trace') */
    type?: string;
    /** sender identity - carried as the batch source. auto random id when omitted (invocation id recommended) */
    source?: string;
    /** levels below this are not sent at all (default 'debug' = everything) */
    minLevel?: LogTraceLevel;
    /** flush when this many entries are buffered (default 20) */
    flushCount?: number;
    /** flush this long after the first buffered entry. 0 disables the timer (default 250) */
    flushIntervalMs?: number;
    /** serialized batch byte budget. split-flush right before exceeding (default 3/4 of maxPacketBytes) */
    maxBatchBytes?: number;
    /** envelope size cap (default 64kb). a single oversized entry drops json + marks truncated */
    maxPacketBytes?: number;
    /** observe send failures and truncations */
    onError?: (error: any, entries: LogTraceEntry[]) => void;
}

export interface LogTraceReporterSupportable {
    /** record one log entry. auto-flushes when a flush condition is reached */
    log(level: LogTraceLevel, message: string, json?: Record<string, any>): void;
    /** level shortcut */
    debug(message: string, json?: Record<string, any>): void;
    info(message: string, json?: Record<string, any>): void;
    warn(message: string, json?: Record<string, any>): void;
    error(message: string, json?: Record<string, any>): void;
    /** send the buffered entries now */
    flush(): void;
    /** flush + release the timer. must be called before a lambda invocation ends. later log calls are ignored */
    close(): void;
}

/** query condition for consumer.list() */
export interface LogTraceQuery {
    /** only this level and above */
    minLevel?: LogTraceLevel;
    /** last n entries (default all) */
    limit?: number;
}

export interface LogTraceConsumerOptions {
    /** inbound envelope type prefix (default 'log:') */
    typePrefix?: string;
    /** received entries below this level are discarded (default 'debug' = everything) */
    minLevel?: LogTraceLevel;
    /** ring buffer retention cap (default 1000) */
    maxEntries?: number;
}

export interface LogTraceConsumerSupportable {
    /** subscribe to received entries - batches are unpacked and notified one entry at a time, in batch order */
    onEntry(handler: (entry: LogTraceEntry) => void): SocketUnsubscribe;
    /** list retained entries - returned in (ts, seq) ascending order */
    list(query?: LogTraceQuery): LogTraceEntry[];
    /** observed wire loss - sum of (max seq - received count) per source. exact regardless of arrival order */
    readonly gapCount: number;
    /** drop retained entries (subscriptions stay) */
    clear(): void;
    /** unsubscribe from the network. does NOT close the network (shared socket) */
    close(): void;
}

const DEFAULT_TYPE = 'log:trace';
const DEFAULT_TYPE_PREFIX = 'log:';
const DEFAULT_MIN_LEVEL: LogTraceLevel = 'debug';
const DEFAULT_FLUSH_COUNT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const LEVEL_WEIGHT: Record<LogTraceLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** create a batching log reporter over an injected send path */
export const createLogTraceReporter = (
    sink: LogTraceSink,
    options?: LogTraceReporterOptions,
): LogTraceReporterSupportable => new LogTraceReporter(sink, options);

/** create a log consumer over a shared raw string network */
export const createLogTraceConsumer = (
    network: NetworkSupportable,
    options?: LogTraceConsumerOptions,
): LogTraceConsumerSupportable => new LogTraceConsumer(network, options);

/** server-side log reporter - batches entries and emits SocketMessage<LogTraceBatch> via the sink */
class LogTraceReporter implements LogTraceReporterSupportable {
    private readonly sink: LogTraceSink;
    private readonly type: string;
    private readonly source: string;
    private readonly minLevel: number;
    private readonly flushCount: number;
    private readonly flushIntervalMs: number;
    private readonly maxBatchBytes: number;
    private readonly onError?: (error: any, entries: LogTraceEntry[]) => void;
    private buffer: LogTraceEntry[] = [];
    private bufferBytes = 0;
    private seqNo = 0;
    private midNo = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private sentOnce = false;
    private closed = false;

    public constructor(sink: LogTraceSink, options?: LogTraceReporterOptions) {
        const maxPacketBytes = options?.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
        this.sink = sink;
        this.type = options?.type ?? DEFAULT_TYPE;
        this.source = options?.source ?? nextRandomSource();
        this.minLevel = LEVEL_WEIGHT[options?.minLevel ?? DEFAULT_MIN_LEVEL];
        this.flushCount = options?.flushCount ?? DEFAULT_FLUSH_COUNT;
        this.flushIntervalMs = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.maxBatchBytes = options?.maxBatchBytes ?? Math.floor((maxPacketBytes * 3) / 4);
        this.onError = options?.onError;
    }

    /** record one log entry. auto-flushes when a flush condition is reached */
    public log(level: LogTraceLevel, message: string, json?: Record<string, any>): void {
        if (this.closed) return;
        //! seq is issued only past this gate so a raised minLevel never creates seq gaps.
        if (LEVEL_WEIGHT[level] < this.minLevel) return;
        const entry: LogTraceEntry = { level, ts: Date.now(), message, seq: ++this.seqNo };
        if (json !== undefined) entry.json = json;
        let bytes = byteLength(JSON.stringify(entry));
        if (bytes > this.maxBatchBytes) bytes = this.truncate(entry, bytes);
        //! adding this entry would exceed the batch budget: flush the current buffer, start a new batch.
        if (this.buffer.length > 0 && this.bufferBytes + bytes + 1 > this.maxBatchBytes) this.flush();
        this.buffer.push(entry);
        this.bufferBytes += bytes + 1;
        if (level === 'error' || this.buffer.length >= this.flushCount) return this.flush();
        if (this.flushIntervalMs <= 0) return;
        //! leading edge: the first batch of this reporter flushes immediately so the viewer never waits a window.
        if (!this.sentOnce) return this.flush();
        if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
    }

    public debug(message: string, json?: Record<string, any>): void {
        this.log('debug', message, json);
    }

    public info(message: string, json?: Record<string, any>): void {
        this.log('info', message, json);
    }

    public warn(message: string, json?: Record<string, any>): void {
        this.log('warn', message, json);
    }

    public error(message: string, json?: Record<string, any>): void {
        this.log('error', message, json);
    }

    /** send the buffered entries now */
    public flush(): void {
        this.clearTimer();
        if (this.buffer.length <= 0) return;
        const entries = this.buffer;
        this.buffer = [];
        this.bufferBytes = 0;
        this.sentOnce = true;
        const message: SocketMessage<LogTraceBatch> = {
            type: this.type,
            data: { entries, source: this.source },
            mid: `l${++this.midNo}`,
        };
        //! at-most-once: a failed batch is reported to onError and dropped. never breaks the caller.
        try {
            const result = this.sink(message);
            if (result && typeof (result as Promise<void>).then === 'function')
                (result as Promise<void>).catch(e => this.emitError(e, entries));
        } catch (e) {
            this.emitError(e, entries);
        }
    }

    /** flush + release the timer. later log calls are ignored */
    public close(): void {
        this.flush();
        this.closed = true;
    }

    /** fit an oversized entry into the batch budget: drop json first, then cut the message */
    private truncate(entry: LogTraceEntry, bytes: number): number {
        const error = new Error(`@entry[${entry.seq}] exceeds batch budget(${this.maxBatchBytes}) - logtrace.truncate`);
        entry.truncated = true;
        if (entry.json !== undefined) {
            delete entry.json;
            bytes = byteLength(JSON.stringify(entry));
        }
        //! every removed character frees at least 1 byte, so this loop converges quickly.
        while (bytes > this.maxBatchBytes && entry.message.length > 0) {
            entry.message = entry.message.slice(0, Math.max(0, entry.message.length - (bytes - this.maxBatchBytes)));
            bytes = byteLength(JSON.stringify(entry));
        }
        this.emitError(error, [entry]);
        return bytes;
    }

    private emitError(error: any, entries: LogTraceEntry[]): void {
        try {
            this.onError?.(error, entries);
        } catch {
            // The error observer must never break the reporter.
        }
    }

    private clearTimer(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}

/** per-source receive state for dedup + wire loss accounting */
interface LogTraceSourceState {
    maxSeq: number;
    seen: Set<number>;
}

/** client-side log consumer - unpacks batches into a (ts, seq)-sorted ring buffer */
class LogTraceConsumer implements LogTraceConsumerSupportable {
    private readonly typePrefix: string;
    private readonly minLevel: number;
    private readonly maxEntries: number;
    private readonly handlers = new Set<(entry: LogTraceEntry) => void>();
    private readonly sources = new Map<string, LogTraceSourceState>();
    private readonly unsubscribe: SocketUnsubscribe;
    private entries: LogTraceEntry[] = [];

    public constructor(network: NetworkSupportable, options?: LogTraceConsumerOptions) {
        this.typePrefix = options?.typePrefix ?? DEFAULT_TYPE_PREFIX;
        this.minLevel = LEVEL_WEIGHT[options?.minLevel ?? DEFAULT_MIN_LEVEL];
        this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        //! raw stage of the 2-stage filter: substring check without parsing.
        const marker = `"type":"${this.typePrefix}`;
        const filtered = createFilteredNetwork(network, raw => raw.includes(marker));
        this.unsubscribe = filtered.onMessage(raw => this.receive(raw));
    }

    /** subscribe to received entries */
    public onEntry(handler: (entry: LogTraceEntry) => void): SocketUnsubscribe {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }

    /** list retained entries in (ts, seq) ascending order */
    public list(query?: LogTraceQuery): LogTraceEntry[] {
        const min = LEVEL_WEIGHT[query?.minLevel ?? DEFAULT_MIN_LEVEL];
        let listed = min > 0 ? this.entries.filter(entry => LEVEL_WEIGHT[entry.level] >= min) : [...this.entries];
        const limit = query?.limit;
        if (limit !== undefined && limit >= 0 && listed.length > limit) listed = listed.slice(listed.length - limit);
        return listed;
    }

    /** observed wire loss - sum of (max seq - received count) per source */
    public get gapCount(): number {
        let gaps = 0;
        for (const state of this.sources.values()) gaps += Math.max(0, state.maxSeq - state.seen.size);
        return gaps;
    }

    /** drop retained entries (subscriptions and loss accounting stay) */
    public clear(): void {
        this.entries = [];
    }

    /** unsubscribe from the network. does NOT close the network (shared socket) */
    public close(): void {
        this.unsubscribe();
        this.handlers.clear();
    }

    private receive(raw: string): void {
        let message: SocketMessage<LogTraceBatch>;
        try {
            message = JSON.parse(raw);
        } catch {
            return; // the raw substring filter is best-effort; a non-JSON hit is simply not ours.
        }
        if (!message || typeof message.type !== 'string' || !message.type.startsWith(this.typePrefix)) return;
        const batch = message.data;
        if (!batch || typeof batch.source !== 'string' || !Array.isArray(batch.entries)) return;
        const state = this.stateOf(batch.source);
        for (const entry of batch.entries) {
            if (!isLogTraceEntry(entry)) continue;
            //! dedup + loss accounting happen BEFORE the minLevel gate so gapCount stays a pure wire-loss metric.
            if (state.seen.has(entry.seq)) continue;
            state.seen.add(entry.seq);
            if (entry.seq > state.maxSeq) state.maxSeq = entry.seq;
            if (LEVEL_WEIGHT[entry.level] < this.minLevel) continue;
            const accepted: LogTraceEntry = { ...entry, source: batch.source };
            this.store(accepted);
            for (const handler of [...this.handlers]) handler(accepted);
        }
    }

    /** binary-insert by (ts, seq) so list() never re-sorts; evict the oldest on overflow */
    private store(entry: LogTraceEntry): void {
        let lo = 0;
        let hi = this.entries.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (compareEntry(this.entries[mid], entry) <= 0) lo = mid + 1;
            else hi = mid;
        }
        this.entries.splice(lo, 0, entry);
        if (this.entries.length > this.maxEntries) this.entries.shift();
    }

    private stateOf(source: string): LogTraceSourceState {
        let state = this.sources.get(source);
        if (!state) {
            // ponytail: the per-source seen Set grows with log volume; swap to seq-range tracking if sessions get huge.
            state = { maxSeq: 0, seen: new Set<number>() };
            this.sources.set(source, state);
        }
        return state;
    }
}

let sourceNo = 0;
const nextRandomSource = (): string => `src-${Math.random().toString(36).slice(2, 8)}${++sourceNo}`;

const compareEntry = (a: LogTraceEntry, b: LogTraceEntry): number => a.ts - b.ts || a.seq - b.seq;

const isLogTraceEntry = (entry: any): entry is LogTraceEntry =>
    !!entry &&
    typeof entry === 'object' &&
    LEVEL_WEIGHT[entry.level as LogTraceLevel] !== undefined &&
    typeof entry.ts === 'number' &&
    typeof entry.message === 'string' &&
    Number.isInteger(entry.seq) &&
    entry.seq > 0;

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;
