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
    /** send a typed JSON response object */
    send(data: T): void;
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
export type JSONTransportPacket = JSONManifestPacket | JSONChunkPacket | JSONCompletePacket | JSONErrorPacket;

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

let transportNo = 0;
let chunkNo = 0;

const DEFAULT_LARGE_VALUE_BYTES = 16 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * 1024;
const DEFAULT_ENVELOPE_RESERVE_BYTES = 1024;
const DEFAULT_PARTIAL_TTL_MS = 5 * 60 * 1000;
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

    public constructor(network: NetworkSupportable, options?: JSONTransportOptions) {
        this.network = network;
        this.options = asJSONTransportOptions(options);
        this.unsubscribeNetworkMessage = network.onMessage(packet => this.receive(packet));
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

    /** send a typed JSON response object */
    public send(data: T): void {
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
        if (this.options.partialTtlMs <= 0) return 0;

        let removed = 0;
        for (const [tid, state] of this.states) {
            if (now - state.updatedAt <= this.options.partialTtlMs) continue;
            this.states.delete(tid);
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
        if (packet.type === 'json:error') {
            this.emitError(new Error(packet.error), { scope: 'json.error', network: this.network });
            return;
        }

        const state = this.getState(packet.tid);
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
    }

    private acceptManifest(state: JSONReceiveState, packet: JSONManifestPacket): boolean {
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
        identityProvider: options?.identityProvider ?? defaultJSONTransportIdentityProvider,
        partialTtlMs: options?.partialTtlMs ?? DEFAULT_PARTIAL_TTL_MS,
        cleanupIntervalMs: options?.cleanupIntervalMs ?? 0,
        logger: options?.logger ?? noopJSONTransportLogger,
        split: options?.split,
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
    return false;
};

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
