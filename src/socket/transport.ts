/**
 * `socket/transport.ts`
 * - JSON response transport over raw in-memory networks.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkSupportable,
    SocketErrorContext,
    SocketErrorHandler,
    SocketLogEntry,
    SocketLogger,
    SocketLogLevel,
    SocketUnsubscribe,
} from './types';

/** callback used by JSONTransport.onMessage(). */
export interface JSONTransportMessageHandler<T extends object> {
    (data: T): void;
}

/** JSON transport options. */
export interface JSONTransportOptions {
    /** string leaf size threshold before chunking */
    largeValueBytes?: number;
    /** max raw chunk payload size in bytes */
    chunkBytes?: number;
    /** reserved network packet bytes for transport envelope overhead */
    envelopeReserveBytes?: number;
    /** GenAI-oriented paths likely to contain large response strings */
    preferredSplitPaths?: string[];
    /** id generator used for transport ids and chunk ids */
    identityProvider?: JSONTransportIdentityProvider;
    /** maximum age for incomplete receive state; set 0 to disable cleanup */
    partialTtlMs?: number;
    /** optional interval for automatic partial receive cleanup; set 0 to disable */
    cleanupIntervalMs?: number;
    /** structured logger for JSON transport diagnostics */
    logger?: SocketLogger;
    /** custom split decision */
    split?: (path: string, value: unknown, size: number) => boolean;
    /**
     * opt-in reliable delivery: exactly-once completion + NACK/blind-resend recovery.
     * while the network stays non-open, retries wait without consuming maxAttempts —
     * the network owner is expected to eventually reconnect or call detach().
     * both the sender and the receiver must opt in — an asymmetric setup surfaces as
     * `JSON_RELIABLE_SCOPE.mismatch` (`json.reliable.mismatch`) on the non-reliable side.
     * onError pattern: `error instanceof JSONTransportReliableError` gives access to `error.tid`.
     */
    reliable?: boolean | ReliableOptions;
}

/** reliable-mode delivery tuning; unset fields fall back to defaults. */
export interface ReliableOptions {
    /** debounce window before receiver emits json:nack after detecting an incomplete tid */
    nackDebounceMs?: number;
    /** blind full-resend interval when neither ack nor nack arrives */
    resendIntervalMs?: number;
    /** retry budget before a send() rejects; ticks while readyState !== 'open' don't count */
    maxAttempts?: number;
    /**
     * absolute wall-clock deadline for one send() unit, measured from its start; unlike
     * maxAttempts, this keeps counting while readyState !== 'open' — a permanently non-open
     * network still fails the send once the deadline passes, even with attempts left.
     */
    deadlineMs?: number;
    /** settled (send/receive) tid memory TTL — absorbs late duplicate retransmits */
    settledTtlMs?: number;
    /**
     * hard cap on settled map size (bounds memory when timers stall). evicts oldest-first —
     * if live tids exceed the cap, a still-valid entry may be evicted early and a late
     * duplicate could then re-emit; size the cap above peak concurrent transfers.
     */
    settledMaxEntries?: number;
    /**
     * subscribe onMessage on this network instead of `network`, while all outbound traffic
     * (data + ack/nack/error) still goes out over `network`. for split unidirectional-pipe
     * topologies (e.g. Peer's uplink/downlink) — write≠read on one merged instance means it
     * never subscribes to its own outbound pipe, so self-echo cannot occur by construction.
     * unused (undefined) for the common single bidirectional network case.
     */
    receiveNetwork?: NetworkSupportable;
}

/** resolved reliable-mode configuration. */
interface ResolvedReliableOptions {
    nackDebounceMs: number;
    resendIntervalMs: number;
    maxAttempts: number;
    deadlineMs: number;
    settledTtlMs: number;
    settledMaxEntries: number;
    receiveNetwork?: NetworkSupportable;
}

/** id generator for deterministic transport tests and custom runtimes. */
export interface JSONTransportIdentityProvider {
    nextTransportId(): string;
    nextChunkId(): string;
}

/** resolved JSON transport configuration. */
export interface ResolvedJSONTransportOptions {
    largeValueBytes: number;
    chunkBytes: number;
    envelopeReserveBytes: number;
    preferredSplitPaths: string[];
    identityProvider: JSONTransportIdentityProvider;
    partialTtlMs: number;
    cleanupIntervalMs: number;
    logger: SocketLogger;
}

/** JSON transport options after defaults are applied. */
export interface RequiredJSONTransportOptions extends ResolvedJSONTransportOptions {
    split?: JSONTransportOptions['split'];
}

/** minimal JSON transport contract. */
export interface JSONTransportSupportable<T extends object> {
    /** underlying raw string network */
    readonly network: NetworkSupportable;
    /** send a typed JSON response object; reliable mode returns a Promise settling on completion/failure */
    send(data: T): void | Promise<void>;
    /** update transport chunking options */
    configure?(options: JSONTransportOptions): void;
    /** subscribe to rebuilt JSON response objects */
    onMessage(handler: JSONTransportMessageHandler<T>): SocketUnsubscribe;
    /** observe JSON transport errors */
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    /** number of incomplete transport messages currently buffered */
    readonly pendingCount: number;
    /** remove expired incomplete transport messages and return removed count */
    cleanup(now?: number): number;
    /** detach from the underlying network and clear local buffers/listeners */
    detach(): void;
}

/** transport packet shape. */
export type JSONTransportPacket =
    | JSONManifestPacket
    | JSONChunkPacket
    | JSONCompletePacket
    | JSONErrorPacket
    | JSONAckPacket
    | JSONNackPacket;

/** manifest packet preserving response shape. */
export interface JSONManifestPacket {
    type: 'json:manifest';
    tid: string;
    root: any;
    refs: JSONChunkRef[];
}

/** chunk packet for one large leaf string. */
export interface JSONChunkPacket {
    type: 'json:chunk';
    tid: string;
    cid: string;
    index: number;
    total: number;
    data: string;
    hash: string;
}

/** completion marker packet. */
export interface JSONCompletePacket {
    type: 'json:complete';
    tid: string;
}

/** transport error packet. */
export interface JSONErrorPacket {
    type: 'json:error';
    tid: string;
    error: string;
}

/** reliable-mode ack: sent by the receiver once a tid is fully assembled or re-settled. */
export interface JSONAckPacket {
    type: 'json:ack';
    tid: string;
}

/** reliable-mode nack: current-state diff sent by the receiver after nackDebounceMs of silence. */
export interface JSONNackPacket {
    type: 'json:nack';
    tid: string;
    manifest?: boolean;
    chunks?: { cid: string; missing: number[] }[];
    complete?: boolean;
}

/** `scope` values reliable-mode puts on `SocketErrorContext` (see `JSONTransportOptions.reliable`) */
export const JSON_RELIABLE_SCOPE = {
    failed: 'json.reliable.failed',
    mismatch: 'json.reliable.mismatch',
    detached: 'json.reliable.detached',
    evicted: 'json.reliable.evicted',
} as const;

/** union of the `scope` strings emitted by reliable-mode JSON transport */
export type JSONReliableScope = typeof JSON_RELIABLE_SCOPE[keyof typeof JSON_RELIABLE_SCOPE];

/** a `JSONReliableScope` re-published by `Peer` under its `peer.transport.` forwarding prefix */
export type PeerPrefixedJSONReliableScope = `peer.transport.${JSONReliableScope}`;

/**
 * true for a direct `json.reliable.*` scope, or its `peer.transport.json.reliable.*` re-published
 * form — `Peer` re-emits transport errors under that prefix (see socket.ts `attachTransport`), so a
 * plain `scope === JSON_RELIABLE_SCOPE.mismatch` check never matches on the Peer path. narrows
 * `scope` to `JSONReliableScope | PeerPrefixedJSONReliableScope` for callers that switch on it.
 */
export const isJSONReliableScope = (scope: string): scope is JSONReliableScope | PeerPrefixedJSONReliableScope =>
    scope.startsWith('json.reliable.') || scope.startsWith('peer.transport.json.reliable.');

/** thrown when a reliable-mode send() exhausts its retry budget without an ack. */
export class JSONTransportReliableError extends Error {
    public readonly tid: string;
    public constructor(message: string, tid: string) {
        super(message);
        this.name = 'JSONTransportReliableError';
        this.tid = tid;
    }
}

/** typed subscription for reliable-mode failures — filters reliable scopes (direct or peer-prefixed) and narrows the error type */
export const onReliableError = (
    source: { onError(handler: SocketErrorHandler): SocketUnsubscribe },
    handler: (error: JSONTransportReliableError, context: SocketErrorContext) => void,
): SocketUnsubscribe =>
    source.onError((error, context) => {
        if (isJSONReliableScope(context.scope) && error instanceof JSONTransportReliableError) handler(error, context);
    });

/** metadata for a chunked string leaf. */
export interface JSONChunkRef {
    cid: string;
    path: string;
    encoding: 'utf8' | 'base64' | string;
    size: number;
    chunks: number;
}

/** marker placed into manifest root where chunked data belongs. */
export interface JSONRefMarker {
    $jsonTransportRef: string;
}

/** split helper result. */
export interface JSONSplitResult {
    tid: string;
    manifest: JSONManifestPacket;
    chunks: JSONChunkPacket[];
    complete: JSONCompletePacket;
    /** lazily computed byte-size summary */
    size: JSONTransportSizeSummary;
    /** lazily compute byte-size summary */
    summarize(): JSONTransportSizeSummary;
    /** send current transport packets through a raw string network */
    send(network: NetworkSupportable): void;
}

/** byte-size summary for split transport packets. */
export interface JSONTransportSizeSummary {
    /** original JSON.stringify(data) byte size */
    originalBytes: number;
    /** serialized manifest packet byte size */
    manifestBytes: number;
    /** serialized chunk packet byte sizes */
    chunkBytes: number[];
    /** serialized complete packet byte size */
    completeBytes: number;
    /** total serialized transport packet bytes */
    totalPacketBytes: number;
    /** transport overhead compared to original JSON bytes */
    overheadBytes: number;
}

/** receiver state for one transport message. */
export interface JSONReceiveState {
    tid: string;
    manifest?: JSONManifestPacket;
    complete?: boolean;
    emitted?: boolean;
    updatedAt: number;
    chunks: Map<string, Map<number, JSONChunkPacket>>;
}

/** sender-side reliable-mode bookkeeping for one in-flight transport unit (tid). */
interface PendingSend {
    manifest: JSONManifestPacket;
    chunks: JSONChunkPacket[];
    complete: JSONCompletePacket;
    attempts: number;
    /** wall-clock start of this send() unit — the deadlineMs baseline */
    startedAt: number;
    resendTimer: ReturnType<typeof setInterval>;
    resolve: () => void;
    reject: (error: any) => void;
}

/** reliable-mode terminal-outcome memory entry (send or receive side). */
interface SettledEntry {
    outcome: 'ok' | 'fail';
    expiresAt: number;
}

let transportNo = 0;
let chunkNo = 0;

const DEFAULT_LARGE_VALUE_BYTES = 16 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * 1024;
const DEFAULT_ENVELOPE_RESERVE_BYTES = 1024;
const DEFAULT_PARTIAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NACK_DEBOUNCE_MS = 150;
const DEFAULT_RESEND_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_SETTLED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SETTLED_MAX_ENTRIES = 10000;
const DEFAULT_PREFERRED_SPLIT_PATHS = [
    '/data/text',
    '/data/content',
    '/data/output',
    '/data/inlineData',
    '/data/parts/*/text',
    '/data/parts/*/inlineData',
];
const noopJSONTransportLogger: SocketLogger = { log: () => undefined };

export const defaultJSONTransportIdentityProvider: JSONTransportIdentityProvider = {
    nextTransportId: () => `json-${++transportNo}`,
    nextChunkId: () => `chunk-${++chunkNo}`,
};

/** reliable-mode default id provider — the counter-based default is unsafe across instance/reconnect boundaries. */
const nextReliableJSONTransportId = (): string =>
    typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `json-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export const defaultReliableJSONTransportIdentityProvider: JSONTransportIdentityProvider = {
    nextTransportId: nextReliableJSONTransportId,
    nextChunkId: nextReliableJSONTransportId,
};

/** create a JSON transport over a raw string network. */
export const createJSONTransport = <T extends object>(
    network: NetworkSupportable,
    options?: JSONTransportOptions,
): JSONTransport<T> => new JSONTransport<T>(network, options);

/** derive chunkBytes from a known raw network packet size. */
export const calculateJSONTransportChunkBytes = (
    maxPacketBytes: number,
    envelopeReserveBytes = resolveEnvelopeReserveBytesByPacketLimit(maxPacketBytes),
): number => {
    const chunkBytes = maxPacketBytes - envelopeReserveBytes;
    if (!Number.isFinite(chunkBytes) || chunkBytes <= 0) {
        throw new Error(`@maxPacketBytes is too small for JSON transport envelope - json.configure`);
    }
    return chunkBytes;
};

/** split a typed JSON response object into transport packets. */
export const splitJSON = <T extends object>(data: T, options?: JSONTransportOptions): JSONSplitResult => {
    const config = asJSONTransportOptions(options);
    const tid = config.identityProvider.nextTransportId();
    const refs: JSONChunkRef[] = [];
    const chunks: JSONChunkPacket[] = [];
    const root = cloneAndSplit(data, '', config, refs, chunks);
    const manifest: JSONManifestPacket = { type: 'json:manifest', tid, root, refs };
    const complete: JSONCompletePacket = { type: 'json:complete', tid };

    for (const chunk of chunks) chunk.tid = tid;

    let summary: JSONTransportSizeSummary | undefined;
    const result: JSONSplitResult = {
        tid,
        manifest,
        chunks,
        complete,
        get size() {
            return (summary ??= summarizeJSONTransportSize(data, manifest, chunks, complete));
        },
        summarize: () => (summary ??= summarizeJSONTransportSize(data, manifest, chunks, complete)),
        send: (network: NetworkSupportable) => {
            for (const packet of [manifest, ...chunks, complete]) {
                network.send(JSON.stringify(packet));
            }
        },
    };
    return result;
};

/** summarize byte-size changes introduced by transport packetization. */
export const summarizeJSONTransportSize = <T extends object>(
    data: T,
    manifest: JSONManifestPacket,
    chunks: JSONChunkPacket[],
    complete: JSONCompletePacket,
): JSONTransportSizeSummary => {
    const originalBytes = byteLength(JSON.stringify(data));
    const manifestBytes = byteLength(JSON.stringify(manifest));
    const chunkBytes = chunks.map(chunk => byteLength(JSON.stringify(chunk)));
    const completeBytes = byteLength(JSON.stringify(complete));
    const totalPacketBytes = manifestBytes + chunkBytes.reduce((sum, size) => sum + size, 0) + completeBytes;

    return {
        originalBytes,
        manifestBytes,
        chunkBytes,
        completeBytes,
        totalPacketBytes,
        overheadBytes: totalPacketBytes - originalBytes,
    };
};

/** assemble a completed receive state into a typed JSON response object. */
export const assembleJSON = <T extends object>(state: JSONReceiveState): T | undefined => {
    const manifest = state.manifest;
    if (!manifest || !state.complete || state.emitted) return undefined;

    const values = new Map<string, string>();
    for (const ref of manifest.refs) {
        const byIndex = state.chunks.get(ref.cid);
        if (!byIndex || byIndex.size < ref.chunks) return undefined;

        const parts: string[] = [];
        for (let index = 0; index < ref.chunks; index++) {
            const chunk = byIndex.get(index);
            if (!chunk) return undefined;
            parts.push(chunk.data);
        }
        values.set(ref.cid, parts.join(''));
    }

    const root = cloneJSON(manifest.root);
    for (const ref of manifest.refs) {
        if (!values.has(ref.cid)) return undefined;
        setByJSONPointer(root, ref.path, values.get(ref.cid));
    }

    return root as T;
};

/** JSON response transport over NetworkSupportable. */
export class JSONTransport<T extends object> implements JSONTransportSupportable<T> {
    public readonly network: NetworkSupportable;
    private options: RequiredJSONTransportOptions;
    private readonly listeners = new Set<JSONTransportMessageHandler<T>>();
    private readonly errorListeners = new Set<SocketErrorHandler>();
    private readonly states = new Map<string, JSONReceiveState>();
    private readonly unsubscribeNetworkMessage: SocketUnsubscribe;
    private readonly unsubscribeNetworkError: SocketUnsubscribe;
    private cleanupTimer?: ReturnType<typeof setInterval>;
    private readonly reliable?: ResolvedReliableOptions;
    private readonly pendingSend?: Map<string, PendingSend>;
    private readonly settledSend?: Map<string, SettledEntry>;
    private readonly settledReceived?: Map<string, SettledEntry>;
    private readonly nackTimers?: Map<string, ReturnType<typeof setTimeout>>;

    public constructor(network: NetworkSupportable, options?: JSONTransportOptions) {
        this.network = network;
        this.options = asJSONTransportOptions(options);
        this.reliable = asResolvedReliableOptions(options?.reliable);
        if (this.reliable) {
            this.pendingSend = new Map();
            this.settledSend = new Map();
            this.settledReceived = new Map();
            this.nackTimers = new Map();
        }
        const receiveNetwork = this.reliable?.receiveNetwork ?? network;
        this.unsubscribeNetworkMessage = receiveNetwork.onMessage(packet => this.receive(packet));
        this.unsubscribeNetworkError = network.onError((error, context) => {
            this.log('error', 'json transport network error', 'json.network', {
                networkId: getNetworkId(network),
                error,
                data: { scope: context.scope },
            });
            this.emitError(error, { ...context, scope: `json.network.${context.scope}`, network });
        });
        this.configureCleanupTimer();
        this.log('debug', 'json transport attached', 'json.constructor', { networkId: getNetworkId(network) });
    }

    /** number of incomplete transport messages currently buffered */
    public get pendingCount(): number {
        return this.states.size;
    }

    /** send a typed JSON response object; reliable mode returns a Promise settling on completion/failure */
    public send(data: T): void | Promise<void> {
        if (this.reliable) return this.sendReliable(data);

        const split = splitJSON(data, this.options);

        try {
            this.log('debug', 'json transport sending packets', 'json.send', {
                networkId: getNetworkId(this.network),
                data: { tid: split.tid, chunks: split.chunks.length },
            });
            split.send(this.network);
        } catch (e) {
            this.log('error', 'json transport send failed', 'json.send', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid: split.tid },
            });
            this.emitError(e, { scope: 'json.send', network: this.network });
            throw e;
        }
    }

    /** update transport chunking options */
    public configure(options: JSONTransportOptions): void {
        this.options = asJSONTransportOptions({ ...this.options, ...options });
        this.configureCleanupTimer();
        this.log('info', 'json transport configured', 'json.configure', {
            networkId: getNetworkId(this.network),
            data: {
                largeValueBytes: this.options.largeValueBytes,
                chunkBytes: this.options.chunkBytes,
                partialTtlMs: this.options.partialTtlMs,
                cleanupIntervalMs: this.options.cleanupIntervalMs,
            },
        });
    }

    /** subscribe to rebuilt JSON response objects */
    public onMessage(handler: JSONTransportMessageHandler<T>): SocketUnsubscribe {
        this.listeners.add(handler);
        return () => {
            this.listeners.delete(handler);
        };
    }

    /** observe JSON transport errors */
    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorListeners.add(handler);
        return () => {
            this.errorListeners.delete(handler);
        };
    }

    /** unsubscribe from the underlying network. */
    public detach(): void {
        if (this.reliable) this.detachReliable();
        this.unsubscribeNetworkMessage();
        this.unsubscribeNetworkError();
        this.clearCleanupTimer();
        this.states.clear();
        this.listeners.clear();
        this.errorListeners.clear();
        this.log('info', 'json transport detached', 'json.detach', { networkId: getNetworkId(this.network) });
    }

    /** remove expired incomplete transport messages and return removed count */
    public cleanup(now = Date.now()): number {
        if (this.reliable) this.sweepSettledMaps(now);
        if (this.options.partialTtlMs <= 0) return 0;

        let removed = 0;
        for (const [tid, state] of this.states) {
            if (now - state.updatedAt <= this.options.partialTtlMs) continue;
            this.states.delete(tid);
            if (this.reliable) {
                this.clearNackTimer(tid);
                this.settleReceived(tid, 'fail');
            }
            removed++;
            this.log('warn', 'json partial message expired', 'json.partial.expired', {
                networkId: getNetworkId(this.network),
                data: { tid },
            });
            this.emitError(new Error(`@json[${tid}] partial message expired - json.partial.expired`), {
                scope: 'json.partial.expired',
                network: this.network,
            });
        }
        return removed;
    }

    private receive(packetString: string): void {
        let packet: JSONTransportPacket;
        try {
            packet = JSON.parse(packetString);
        } catch (e) {
            this.log('error', 'json packet parse failed', 'json.parse', {
                networkId: getNetworkId(this.network),
                error: e,
            });
            this.emitError(e, { scope: 'json.parse', network: this.network });
            return;
        }

        if (!isJSONTransportPacket(packet)) {
            this.log('error', 'json packet is invalid', 'json.packet', { networkId: getNetworkId(this.network) });
            this.emitError(new Error(`@packet is invalid - json.packet`), {
                scope: 'json.packet',
                network: this.network,
            });
            return;
        }

        if (!this.reliable && (packet.type === 'json:ack' || packet.type === 'json:nack')) {
            this.log('error', 'json packet requires reliable mode', JSON_RELIABLE_SCOPE.mismatch, {
                networkId: getNetworkId(this.network),
                data: { tid: packet.tid, type: packet.type },
            });
            this.emitError(
                new Error(`@packet[${packet.type}] requires reliable mode - ${JSON_RELIABLE_SCOPE.mismatch}`),
                { scope: JSON_RELIABLE_SCOPE.mismatch, network: this.network },
            );
            return;
        }

        try {
            this.log('debug', 'json packet received', 'json.receive', {
                networkId: getNetworkId(this.network),
                data: { tid: packet.tid, type: packet.type },
            });
            this.acceptPacket(packet);
        } catch (e) {
            this.log('error', 'json packet handling failed', 'json.packet', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid: packet.tid, type: packet.type },
            });
            this.emitError(e, { scope: 'json.packet', network: this.network });
        }
    }

    private acceptPacket(packet: JSONTransportPacket): void {
        if (this.reliable && (packet.type === 'json:ack' || packet.type === 'json:nack')) {
            if (packet.type === 'json:ack') this.handleAck(packet);
            else this.handleNack(packet);
            return;
        }

        if (packet.type === 'json:error') {
            this.emitError(new Error(packet.error), { scope: 'json.error', network: this.network });
            if (this.reliable) {
                this.states.delete(packet.tid);
                this.clearNackTimer(packet.tid);
                this.settleReceived(packet.tid, 'fail');
            }
            return;
        }

        if (this.reliable && this.settledReceived!.has(packet.tid)) {
            if (this.settledReceived!.get(packet.tid)!.outcome === 'ok') this.sendAck(packet.tid);
            return;
        }

        const state = this.getState(packet.tid);
        if (this.reliable) this.scheduleNack(state.tid);
        if (packet.type === 'json:manifest' && !this.acceptManifest(state, packet)) return;
        if (packet.type === 'json:complete') state.complete = true;
        if (packet.type === 'json:chunk') this.acceptChunk(state, packet);
        if (!this.validateCompletedChunkSizes(state)) return;

        const data = assembleJSON<T>(state);
        if (!data) return;

        state.emitted = true;
        this.states.delete(state.tid);
        this.log('debug', 'json message assembled', 'json.assemble', {
            networkId: getNetworkId(this.network),
            data: { tid: state.tid },
        });
        for (const listener of [...this.listeners]) listener(data);
        if (this.reliable) {
            this.clearNackTimer(state.tid);
            this.settleReceived(state.tid, 'ok');
            this.sendAck(state.tid);
        }
    }

    private acceptManifest(state: JSONReceiveState, packet: JSONManifestPacket): boolean {
        if (this.reliable && state.manifest) return true; // retransmit of an already-accepted manifest — idempotent no-op

        if (state.manifest) {
            this.emitError(new Error(`@manifest[${packet.tid}] is duplicated - json.manifest.duplicate`), {
                scope: 'json.manifest.duplicate',
                network: this.network,
            });
            return false;
        }

        if (!this.validateManifest(packet)) return false;
        state.manifest = packet;
        return this.validateBufferedChunks(state);
    }

    private acceptChunk(state: JSONReceiveState, packet: JSONChunkPacket): void {
        if (packet.hash !== hashString(packet.data)) {
            this.emitError(new Error(`@chunk[${packet.cid}:${packet.index}] hash mismatch - json.chunk.hash`), {
                scope: 'json.chunk.hash',
                network: this.network,
            });
            return;
        }
        if (state.manifest && !this.validateChunkForManifest(state.manifest, packet)) return;

        let byIndex = state.chunks.get(packet.cid);
        if (!byIndex) {
            byIndex = new Map<number, JSONChunkPacket>();
            state.chunks.set(packet.cid, byIndex);
        }
        if (this.reliable && byIndex.has(packet.index)) return; // retransmit of an already-accepted chunk — idempotent no-op
        if (byIndex.has(packet.index)) {
            this.emitError(new Error(`@chunk[${packet.cid}:${packet.index}] is duplicated - json.chunk.duplicate`), {
                scope: 'json.chunk.duplicate',
                network: this.network,
            });
            return;
        }
        byIndex.set(packet.index, packet);
        state.updatedAt = Date.now();
    }

    /** reliable send(): split once, register pendingSend, attempt delivery, arm the blind-resend timer. */
    private sendReliable(data: T): Promise<void> {
        const reliable = this.reliable!;
        const split = splitJSON(data, this.options);
        const tid = split.tid;

        let resolvePromise!: () => void;
        let rejectPromise!: (error: any) => void;
        const promise = new Promise<void>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });

        const pending: PendingSend = {
            manifest: split.manifest,
            chunks: split.chunks,
            complete: split.complete,
            attempts: 0,
            startedAt: Date.now(),
            resendTimer: setInterval(() => this.resendTick(tid), reliable.resendIntervalMs),
            resolve: resolvePromise,
            reject: rejectPromise,
        };
        this.pendingSend!.set(tid, pending);
        this.attemptSend(tid, pending);

        //! self-catch: keep returning the original promise so real listeners still observe
        //! resolve/reject, while a discarded return value never surfaces an unhandled rejection.
        promise.catch(() => undefined);
        return promise;
    }

    /** deliver (or re-deliver) the full pendingSend packet set; readyState!=='open' ticks don't count. */
    private attemptSend(tid: string, pending: PendingSend): void {
        const reliable = this.reliable!;
        //! deadlineMs is a wall-clock cap independent of readyState — it still fires while the
        //! network stays permanently non-open, unlike maxAttempts which only counts open ticks.
        if (Date.now() - pending.startedAt >= reliable.deadlineMs) {
            this.failSend(tid, pending, 'deadline exceeded');
            return;
        }
        if (this.network.readyState !== 'open') return;

        pending.attempts++;
        try {
            for (const packet of [pending.manifest, ...pending.chunks, pending.complete]) {
                this.network.send(JSON.stringify(packet));
            }
            this.log('debug', 'json transport sending reliable packets', 'json.send', {
                networkId: getNetworkId(this.network),
                data: { tid, attempt: pending.attempts, chunks: pending.chunks.length },
            });
        } catch (e) {
            this.log('warn', 'json transport reliable send attempt failed', 'json.send', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid, attempt: pending.attempts },
            });
        }

        if (pending.attempts >= reliable.maxAttempts) this.failSend(tid, pending, 'max attempts exceeded');
    }

    private resendTick(tid: string): void {
        const pending = this.pendingSend?.get(tid);
        if (!pending) return;
        this.attemptSend(tid, pending);
    }

    private handleAck(packet: JSONAckPacket): void {
        const pending = this.pendingSend?.get(packet.tid);
        if (!pending) return; // unknown/already-settled tid — silently ignored

        clearInterval(pending.resendTimer);
        this.pendingSend!.delete(packet.tid);
        this.settleSend(packet.tid, 'ok');
        pending.resolve();
    }

    private handleNack(packet: JSONNackPacket): void {
        const pending = this.pendingSend?.get(packet.tid);
        if (!pending) return; // unknown/already-settled tid — silently ignored

        try {
            if (packet.manifest) this.network.send(JSON.stringify(pending.manifest));
            for (const entry of packet.chunks ?? []) {
                for (const index of entry.missing) {
                    const chunk = pending.chunks.find(item => item.cid === entry.cid && item.index === index);
                    if (chunk) this.network.send(JSON.stringify(chunk));
                }
            }
            if (packet.complete) this.network.send(JSON.stringify(pending.complete));
        } catch (e) {
            this.log('warn', 'json transport nack-driven resend failed', 'json.nack', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid: packet.tid },
            });
        }
    }

    private failSend(tid: string, pending: PendingSend, reason: string): void {
        clearInterval(pending.resendTimer);
        this.pendingSend!.delete(tid);
        try {
            this.network.send(JSON.stringify({ type: 'json:error', tid, error: reason } as JSONErrorPacket));
        } catch {
            // best-effort notification only — the reject below is the source of truth
        }
        this.settleSend(tid, 'fail');
        const error = new JSONTransportReliableError(`@json[${tid}] ${reason} - ${JSON_RELIABLE_SCOPE.failed}`, tid);
        this.emitError(error, { scope: JSON_RELIABLE_SCOPE.failed, network: this.network });
        pending.reject(error);
    }

    /** send-side ack/nack listening happens on `receiveNetwork`; acks/nacks/errors are emitted on `network`. */
    private sendAck(tid: string): void {
        try {
            this.network.send(JSON.stringify({ type: 'json:ack', tid } as JSONAckPacket));
        } catch (e) {
            this.log('warn', 'json transport ack send failed', 'json.ack', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid },
            });
        }
    }

    private scheduleNack(tid: string): void {
        const reliable = this.reliable;
        if (!reliable) return;
        this.clearNackTimer(tid);
        const timer = setTimeout(() => this.fireNack(tid), reliable.nackDebounceMs);
        this.nackTimers!.set(tid, timer);
    }

    private clearNackTimer(tid: string): void {
        const timer = this.nackTimers?.get(tid);
        if (!timer) return;
        clearTimeout(timer);
        this.nackTimers!.delete(tid);
    }

    private fireNack(tid: string): void {
        this.nackTimers!.delete(tid);
        const state = this.states.get(tid);
        if (!state || state.emitted) return; // already completed/removed — nothing to nack

        try {
            this.network.send(JSON.stringify(this.buildNackPacket(state)));
        } catch (e) {
            this.log('warn', 'json transport nack send failed', 'json.nack', {
                networkId: getNetworkId(this.network),
                error: e,
                data: { tid },
            });
        }
    }

    /** recompute the current diff (not cumulative) between what's buffered and what the manifest declares. */
    private buildNackPacket(state: JSONReceiveState): JSONNackPacket {
        const nack: JSONNackPacket = { type: 'json:nack', tid: state.tid };
        if (!state.manifest) {
            nack.manifest = true;
            return nack;
        }

        const chunkEntries: { cid: string; missing: number[] }[] = [];
        for (const ref of state.manifest.refs) {
            const byIndex = state.chunks.get(ref.cid);
            const missing: number[] = [];
            for (let index = 0; index < ref.chunks; index++) {
                if (!byIndex?.has(index)) missing.push(index);
            }
            if (missing.length > 0) chunkEntries.push({ cid: ref.cid, missing });
        }
        if (chunkEntries.length > 0) nack.chunks = chunkEntries;
        if (!state.complete) nack.complete = true;
        return nack;
    }

    private settleSend(tid: string, outcome: 'ok' | 'fail'): void {
        const reliable = this.reliable!;
        this.settledSend!.set(tid, { outcome, expiresAt: Date.now() + reliable.settledTtlMs });
        this.sweepSettledMapSize(this.settledSend!, reliable.settledMaxEntries, 'send');
    }

    private settleReceived(tid: string, outcome: 'ok' | 'fail'): void {
        const reliable = this.reliable!;
        this.settledReceived!.set(tid, { outcome, expiresAt: Date.now() + reliable.settledTtlMs });
        this.sweepSettledMapSize(this.settledReceived!, reliable.settledMaxEntries, 'received');
    }

    private sweepSettledMaps(now: number): void {
        const reliable = this.reliable;
        if (!reliable) return;
        this.sweepSettledMapTtl(this.settledSend!, now);
        this.sweepSettledMapTtl(this.settledReceived!, now);
    }

    private sweepSettledMapTtl(map: Map<string, SettledEntry>, now: number): void {
        for (const [tid, entry] of map) {
            if (now >= entry.expiresAt) map.delete(tid);
        }
    }

    /**
     * evicts past maxEntries by priority — TTL-expired entries first, then 'fail' outcomes, and only as a
     * last resort a still-valid 'ok' entry (oldest within each tier); only that last case warns, since it's
     * the only one that can cause a late duplicate to re-emit to listeners.
     */
    private sweepSettledMapSize(map: Map<string, SettledEntry>, maxEntries: number, kind: 'send' | 'received'): void {
        const now = Date.now();
        while (map.size > maxEntries) {
            const victim = this.pickSettledEvictionVictim(map, now);
            if (victim === undefined) break;
            const entry = map.get(victim)!;
            map.delete(victim);
            if (entry.outcome === 'ok' && now < entry.expiresAt) {
                this.log('warn', 'json reliable settled memory evicted before TTL', JSON_RELIABLE_SCOPE.evicted, {
                    networkId: getNetworkId(this.network),
                    data: { tid: victim, kind, maxEntries },
                });
            }
        }
    }

    /** oldest TTL-expired entry, else oldest 'fail' entry, else the oldest entry overall (a still-valid 'ok'). */
    private pickSettledEvictionVictim(map: Map<string, SettledEntry>, now: number): string | undefined {
        const oldest = map.keys().next().value;
        if (oldest === undefined) return undefined;
        if (now >= map.get(oldest)!.expiresAt) return oldest;
        for (const [tid, entry] of map) {
            if (entry.outcome === 'fail') return tid;
        }
        return oldest;
    }

    /** idempotent: settles in-flight sends as failed and clears reliable-mode timers. */
    private detachReliable(): void {
        for (const [tid, pending] of this.pendingSend!) {
            clearInterval(pending.resendTimer);
            this.pendingSend!.delete(tid);
            this.settleSend(tid, 'fail');
            pending.reject(
                new JSONTransportReliableError(
                    `@json[${tid}] transport detached - ${JSON_RELIABLE_SCOPE.detached}`,
                    tid,
                ),
            );
        }
        for (const [tid, timer] of this.nackTimers!) {
            clearTimeout(timer);
            this.nackTimers!.delete(tid);
        }
    }

    private validateManifest(manifest: JSONManifestPacket): boolean {
        const refs = new Map<string, JSONChunkRef>();
        for (const ref of manifest.refs) {
            if (refs.has(ref.cid)) {
                this.emitError(new Error(`@ref[${ref.cid}] is duplicated - json.ref.duplicate`), {
                    scope: 'json.ref.duplicate',
                    network: this.network,
                });
                return false;
            }
            refs.set(ref.cid, ref);

            const marker = getByJSONPointer(manifest.root, ref.path);
            if (!isJSONRefMarker(marker) || marker.$jsonTransportRef !== ref.cid) {
                this.emitError(new Error(`@ref[${ref.cid}] path is invalid - json.ref.path`), {
                    scope: 'json.ref.path',
                    network: this.network,
                });
                return false;
            }
        }
        return true;
    }

    private validateBufferedChunks(state: JSONReceiveState): boolean {
        const manifest = state.manifest;
        if (!manifest) return true;
        for (const byIndex of state.chunks.values()) {
            for (const chunk of byIndex.values()) {
                if (!this.validateChunkForManifest(manifest, chunk)) return false;
            }
        }
        return true;
    }

    private validateChunkForManifest(manifest: JSONManifestPacket, packet: JSONChunkPacket): boolean {
        const ref = manifest.refs.find(item => item.cid === packet.cid);
        if (!ref) {
            this.emitError(new Error(`@chunk[${packet.cid}] has no ref - json.chunk.ref`), {
                scope: 'json.chunk.ref',
                network: this.network,
            });
            return false;
        }
        if (packet.total !== ref.chunks) {
            this.emitError(new Error(`@chunk[${packet.cid}] total mismatch - json.chunk.total`), {
                scope: 'json.chunk.total',
                network: this.network,
            });
            return false;
        }
        return true;
    }

    private validateCompletedChunkSizes(state: JSONReceiveState): boolean {
        const manifest = state.manifest;
        if (!manifest) return true;

        for (const ref of manifest.refs) {
            const byIndex = state.chunks.get(ref.cid);
            if (!byIndex || byIndex.size < ref.chunks) continue;

            const parts: string[] = [];
            for (let index = 0; index < ref.chunks; index++) {
                const chunk = byIndex.get(index);
                if (!chunk) return true;
                parts.push(chunk.data);
            }

            if (byteLength(parts.join('')) !== ref.size) {
                this.emitError(new Error(`@ref[${ref.cid}] size mismatch - json.ref.size`), {
                    scope: 'json.ref.size',
                    network: this.network,
                });
                return false;
            }
        }
        return true;
    }

    private getState(tid: string): JSONReceiveState {
        this.cleanup();
        let state = this.states.get(tid);
        if (!state) {
            state = { tid, updatedAt: Date.now(), chunks: new Map() };
            this.states.set(tid, state);
        }
        state.updatedAt = Date.now();
        return state;
    }

    private emitError(error: any, context: SocketErrorContext): void {
        this.log('error', 'json transport error emitted', 'json.emitError', {
            networkId: getNetworkId(context.network ?? this.network),
            error,
            data: { scope: context.scope },
        });
        for (const listener of [...this.errorListeners]) listener(error, context);
    }

    private log(
        level: SocketLogLevel,
        message: string,
        location: string,
        entry?: Partial<Omit<SocketLogEntry, 'time' | 'level' | 'message' | 'location' | 'error'>> & { error?: any },
    ): void {
        try {
            this.options.logger.log({
                time: Date.now(),
                level,
                message,
                location,
                ...entry,
                error: entry?.error == null ? undefined : normalizeError(entry.error),
            });
        } catch {
            // Logging must never break JSON transport behavior.
        }
    }

    private configureCleanupTimer(): void {
        this.clearCleanupTimer();
        if (this.options.partialTtlMs <= 0 || this.options.cleanupIntervalMs <= 0) return;
        this.cleanupTimer = setInterval(() => this.cleanup(), this.options.cleanupIntervalMs);
    }

    private clearCleanupTimer(): void {
        if (!this.cleanupTimer) return;
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
    }
}

const asJSONTransportOptions = (options?: JSONTransportOptions): RequiredJSONTransportOptions => {
    const envelopeReserveBytes = options?.envelopeReserveBytes ?? DEFAULT_ENVELOPE_RESERVE_BYTES;
    return {
        largeValueBytes: options?.largeValueBytes ?? DEFAULT_LARGE_VALUE_BYTES,
        chunkBytes: options?.chunkBytes ?? DEFAULT_CHUNK_BYTES,
        envelopeReserveBytes,
        preferredSplitPaths: options?.preferredSplitPaths ?? DEFAULT_PREFERRED_SPLIT_PATHS,
        identityProvider:
            options?.identityProvider ??
            (options?.reliable ? defaultReliableJSONTransportIdentityProvider : defaultJSONTransportIdentityProvider),
        partialTtlMs: options?.partialTtlMs ?? DEFAULT_PARTIAL_TTL_MS,
        cleanupIntervalMs: options?.cleanupIntervalMs ?? 0,
        logger: options?.logger ?? noopJSONTransportLogger,
        split: options?.split,
    };
};

/** resolve reliable-mode options; returns undefined (off) when `reliable` is falsy. */
const asResolvedReliableOptions = (reliable?: boolean | ReliableOptions): ResolvedReliableOptions | undefined => {
    if (!reliable) return undefined;
    const options = reliable === true ? {} : reliable;
    return {
        nackDebounceMs: options.nackDebounceMs ?? DEFAULT_NACK_DEBOUNCE_MS,
        resendIntervalMs: options.resendIntervalMs ?? DEFAULT_RESEND_INTERVAL_MS,
        maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
        settledTtlMs: options.settledTtlMs ?? DEFAULT_SETTLED_TTL_MS,
        settledMaxEntries: options.settledMaxEntries ?? DEFAULT_SETTLED_MAX_ENTRIES,
        receiveNetwork: options.receiveNetwork,
    };
};

const resolveEnvelopeReserveBytesByPacketLimit = (maxPacketBytes: number): number =>
    Math.min(DEFAULT_ENVELOPE_RESERVE_BYTES, Math.max(64, Math.floor(maxPacketBytes / 2)));

const cloneAndSplit = (
    value: any,
    path: string,
    options: RequiredJSONTransportOptions,
    refs: JSONChunkRef[],
    chunks: JSONChunkPacket[],
): any => {
    if (typeof value === 'string') {
        const size = byteLength(value);
        if (!shouldSplit(path, value, size, options)) return value;

        const cid = options.identityProvider.nextChunkId();
        const parts = splitStringByBytes(value, options.chunkBytes);
        refs.push({ cid, path, encoding: 'utf8', size, chunks: parts.length });
        parts.forEach((data, index) => {
            chunks.push({ type: 'json:chunk', tid: '', cid, index, total: parts.length, data, hash: hashString(data) });
        });
        return { $jsonTransportRef: cid };
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => cloneAndSplit(item, `${path}/${index}`, options, refs, chunks));
    }

    if (value && typeof value === 'object') {
        const cloned: Record<string, any> = {};
        for (const [key, item] of Object.entries(value)) {
            const nextPath = `${path}/${escapeJSONPointer(key)}`;
            cloned[key] = cloneAndSplit(item, nextPath, options, refs, chunks);
        }
        return cloned;
    }

    return value;
};

const shouldSplit = (path: string, value: string, size: number, options: RequiredJSONTransportOptions): boolean => {
    if (options.split?.(path, value, size)) return true;
    const preferredThreshold = Math.min(options.largeValueBytes, options.chunkBytes);
    if (matchesPreferredSplitPath(path, options.preferredSplitPaths) && size > preferredThreshold) {
        return true;
    }
    return size > options.largeValueBytes;
};

const matchesPreferredSplitPath = (path: string, patterns: string[]): boolean => {
    const pathSegments = path.split('/').slice(1);
    for (const pattern of patterns) {
        const patternSegments = pattern.split('/').slice(1);
        if (pathSegments.length !== patternSegments.length) continue;
        const matched = patternSegments.every((segment, index) => segment === '*' || segment === pathSegments[index]);
        if (matched) return true;
    }
    return false;
};

const splitStringByBytes = (value: string, chunkBytes: number): string[] => {
    if (chunkBytes <= 0) throw new Error(`@chunkBytes should be positive - json.configure`);

    const parts: string[] = [];
    let buffer = '';
    let bufferBytes = 0;

    for (const char of value) {
        const charBytes = byteLength(char);
        if (charBytes > chunkBytes) throw new Error(`@chunkBytes is too small for a character - json.split`);
        if (buffer && bufferBytes + charBytes > chunkBytes) {
            parts.push(buffer);
            buffer = '';
            bufferBytes = 0;
        }
        buffer += char;
        bufferBytes += charBytes;
    }

    if (buffer || parts.length <= 0) parts.push(buffer);
    return parts;
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

const hashString = (value: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).slice(0, 8);
};

const cloneJSON = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const setByJSONPointer = (root: any, path: string, value: any): void => {
    const segments = path.split('/').slice(1).map(unescapeJSONPointer);

    if (segments.length <= 0) throw new Error(`@path is required - json.ref.path`);

    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
        if (cursor == null || typeof cursor !== 'object') {
            throw new Error(`@path[${path}] is invalid - json.ref.path`);
        }
        cursor = cursor[segment];
    }

    const last = segments[segments.length - 1];
    if (cursor == null || typeof cursor !== 'object') {
        throw new Error(`@path[${path}] is invalid - json.ref.path`);
    }
    cursor[last] = value;
};

const getByJSONPointer = (root: any, path: string): any => {
    const segments = path.split('/').slice(1).map(unescapeJSONPointer);
    if (segments.length <= 0) return root;

    let cursor = root;
    for (const segment of segments) {
        if (cursor == null || typeof cursor !== 'object') return undefined;
        cursor = cursor[segment];
    }
    return cursor;
};

const escapeJSONPointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapeJSONPointer = (value: string) => value.replace(/~1/g, '/').replace(/~0/g, '~');

const isJSONTransportPacket = (packet: any): packet is JSONTransportPacket => {
    if (!packet || typeof packet !== 'object') return false;
    if (typeof packet.type !== 'string' || typeof packet.tid !== 'string') return false;

    if (packet.type === 'json:manifest') {
        return 'root' in packet && Array.isArray(packet.refs) && packet.refs.every(isJSONChunkRef);
    }
    if (packet.type === 'json:chunk') {
        return (
            typeof packet.cid === 'string' &&
            Number.isInteger(packet.index) &&
            Number.isInteger(packet.total) &&
            packet.index >= 0 &&
            packet.total > 0 &&
            packet.index < packet.total &&
            typeof packet.data === 'string' &&
            typeof packet.hash === 'string'
        );
    }
    if (packet.type === 'json:complete') return true;
    if (packet.type === 'json:error') return typeof packet.error === 'string';
    if (packet.type === 'json:ack') return true;
    if (packet.type === 'json:nack') return isJSONNackPacketShape(packet);
    return false;
};

const isJSONNackPacketShape = (packet: any): boolean =>
    (packet.manifest === undefined || typeof packet.manifest === 'boolean') &&
    (packet.complete === undefined || typeof packet.complete === 'boolean') &&
    (packet.chunks === undefined || (Array.isArray(packet.chunks) && packet.chunks.every(isJSONNackChunkEntry)));

const isJSONNackChunkEntry = (entry: any): boolean =>
    entry &&
    typeof entry === 'object' &&
    typeof entry.cid === 'string' &&
    Array.isArray(entry.missing) &&
    entry.missing.every((index: any) => Number.isInteger(index) && index >= 0);

const isJSONChunkRef = (ref: any): ref is JSONChunkRef =>
    ref &&
    typeof ref === 'object' &&
    typeof ref.cid === 'string' &&
    typeof ref.path === 'string' &&
    typeof ref.encoding === 'string' &&
    Number.isInteger(ref.size) &&
    ref.size >= 0 &&
    Number.isInteger(ref.chunks) &&
    ref.chunks > 0;

const isJSONRefMarker = (value: any): value is JSONRefMarker =>
    value && typeof value === 'object' && !Array.isArray(value) && typeof value.$jsonTransportRef === 'string';

const getNetworkId = (network?: NetworkSupportable): string | undefined => {
    const id = (network as any)?.id;
    return typeof id === 'string' ? id : undefined;
};

const normalizeError = (error: any): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};
