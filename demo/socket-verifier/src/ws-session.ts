/**
 * mode B (real WebSocket) verifier session: assembles the network stack in the handshake ->
 * owned -> filtered -> conditioned -> JSONTransport order (02-design.md wiring) and converts every
 * observable event (tap/logger/onError) into `TimelineEvent`s. Reconnect recreates the whole stack
 * (01-spec key decision 5); `ping` is intentionally left unimplemented (mode 'peer' only).
 */
import type { NetworkSupportable, SocketLogEntry, SocketLogger } from '@socket/types';
import {
    createFilteredNetwork,
    createOwnedWebSocketNetwork,
    waitWebSocketConnectionId,
    WEBSOCKET_NETWORK_SCOPE,
    type OwnedWebSocketNetwork,
    type WebSocketClosable,
} from '@socket/websocket';
import { createJSONTransport, type JSONTransport, type ReliableOptions } from '@socket/transport';
import { createConditionedNetwork, type ConditionedNetwork } from './conditioned-network';
import { DEFAULT_VERIFIER_CONDITION } from './types';
import type { NetworkTapEvent, VerifierCondition, VerifierSession } from './types';
import type { NewTimelineEvent, VerifierStore } from './verifier-store';

const CONNECT_MESSAGE = '{"action":"connect"}';
/** transport wraps every network onError context as `json.network.${originalScope}` (transport.ts:319) */
const CLOSE_SCOPE = `json.network.${WEBSOCKET_NETWORK_SCOPE.ownedClose}`;

export interface CreateWsSessionOptions {
    id: string;
    url: string;
    store: VerifierStore;
    /**
     * defaults: cleanupIntervalMs 1000, partialTtlMs 10000 (01-spec reassembly state model).
     * `reliable`: opt into JSONTransport's exactly-once delivery (reliable-chunk-transport 01-spec) — also
     * connects with the mock server's `unicast: true` handshake flag so this connection stops receiving its
     * own broadcast (self-echo), matching the reliable-mode unicast premise. Pass a `ReliableOptions` object
     * (instead of `true`) to tune per-role timing — the demo's scenario presets do this so the receiver
     * nacks fast while the sender's blind resend stays slow, making the NACK path clearly observable.
     */
    transportOptions?: { cleanupIntervalMs?: number; partialTtlMs?: number; reliable?: boolean | ReliableOptions };
}

/** `VerifierSession` plus the attach point the Sockets-section extension (multi-session.ts) needs */
export interface WsVerifierSession extends VerifierSession {
    /** the primary owned network, before the filtered/conditioned/transport decorators; undefined before connect()/after close() */
    getPrimaryNetwork(): NetworkSupportable | undefined;
    /** deterministically drop the next `count` outbound frames matching the current dropFilter (scenario presets) */
    armForceDrop(count: number): void;
}

/** create a mode 'ws' `VerifierSession` over a real WebSocket */
export const createWsSession = (options: CreateWsSessionOptions): WsVerifierSession => {
    const { id, url, store } = options;
    const cleanupIntervalMs = options.transportOptions?.cleanupIntervalMs ?? 1000;
    const partialTtlMs = options.transportOptions?.partialTtlMs ?? 10000;
    const reliable = options.transportOptions?.reliable ?? false;

    const reliableEnabled = !!reliable;
    let condition: VerifierCondition = { ...DEFAULT_VERIFIER_CONDITION };
    let ws: WebSocketClosable | undefined;
    let owned: OwnedWebSocketNetwork | undefined;
    let conditioned: ConditionedNetwork | undefined;
    let transport: JSONTransport<Record<string, unknown>> | undefined;
    let unsubMessage: (() => void) | undefined;
    let unsubError: (() => void) | undefined;
    let unsubInbound: (() => void) | undefined;
    /** tid -> first chunk-out time, scoped to chunked round-trips only (non-chunked receives stay out of scope) */
    const chunkOutAt = new Map<string, number>();
    /** receiver-side reassembly tally per tid: distinct chunk indices seen + summed frame bytes, feeding the `assembled … · N chunks · ~KB` row */
    const chunkInAgg = new Map<string, { total: number; bytes: number; seen: Set<number> }>();

    const accrueInboundChunk = (tid: string, index: number, total: unknown, bytes: number): void => {
        let agg = chunkInAgg.get(tid);
        if (!agg) {
            agg = { total: 0, bytes: 0, seen: new Set() };
            chunkInAgg.set(tid, agg);
        }
        if (typeof total === 'number' && total > agg.total) agg.total = total;
        if (!agg.seen.has(index)) {
            agg.seen.add(index);
            agg.bytes += bytes;
        }
    };

    const push = (event: Omit<NewTimelineEvent, 'connectionId'>) => store.pushEvent({ connectionId: id, ...event });
    const notePending = () => transport && store.notePendingCount(id, transport.pendingCount);

    /**
     * inbound json:chunk observer: the transport's own `json.receive` log only carries { tid, type }, so the
     * receiver side can't rebuild the chunk grid. We tap the raw inbound frame (below the transport, so this
     * fires before the transport assembles) to emit a per-chunk `receive` carrying index/total — the mirror of
     * the sender's chunk-out tap, giving the receiver card a symmetric grid and a clean `chunk in ×N` fold.
     */
    const observeInboundChunk = (raw: string): void => {
        let packet: any;
        try {
            packet = JSON.parse(raw);
        } catch {
            return;
        }
        if (!packet || packet.type !== 'json:chunk' || typeof packet.index !== 'number') return;
        const bytes = raw.length;
        if (typeof packet.tid === 'string') accrueInboundChunk(packet.tid, packet.index, packet.total, bytes);
        push({
            direction: 'in',
            kind: 'receive',
            severity: 'normal',
            detail: `chunk in ${packet.index}/${packet.total} tid=${packet.tid ?? ''} (${formatKB(bytes)})`,
            meta: { type: 'json:chunk', tid: packet.tid, index: packet.index, total: packet.total, bytes },
        });
    };

    /** unknown log locations are ignored on purpose (design risk: transport refactors may drop kinds) */
    const logger: SocketLogger = {
        log: (entry: SocketLogEntry) => {
            if (entry.location === 'json.receive') {
                const type = entry.data?.type as string | undefined;
                if (type === 'json:ack') {
                    push({
                        direction: 'in',
                        kind: 'ack',
                        severity: 'normal',
                        detail: `ack tid=${entry.data?.tid ?? ''}`,
                        meta: entry.data,
                    });
                } else if (type === 'json:nack') {
                    push({
                        direction: 'in',
                        kind: 'nack',
                        severity: 'normal',
                        detail: `nack tid=${entry.data?.tid ?? ''}`,
                        meta: entry.data,
                    });
                } else if (type !== 'json:chunk' && type !== 'json:manifest' && type !== 'json:complete') {
                    // json:chunk is emitted (with index/total) by observeInboundChunk; manifest/complete are
                    // transport-internal framing — keeping them out mirrors the send side, which only surfaces
                    // json:chunk as `chunk out`, so the receive side folds cleanly into `chunk in ×N`.
                    push({
                        direction: 'in',
                        kind: 'receive',
                        severity: 'normal',
                        detail: `packet ${entry.data?.type ?? ''} tid=${entry.data?.tid ?? ''}`,
                        meta: entry.data,
                    });
                }
                // transport logs 'json.receive' before it updates its internal pending state for this packet
                // (transport.ts:437 precedes acceptPacket); defer so pendingCount reflects this packet too
                queueMicrotask(notePending);
            } else if (
                entry.location === 'json.send' &&
                typeof entry.data?.attempt === 'number' &&
                entry.data.attempt > 1
            ) {
                // reliable mode's blind/nack-driven resend re-logs 'json.send' with an incrementing attempt
                // (transport.ts attemptSend); attempt 1 is the initial send, already covered by doSend()'s own push
                push({
                    direction: 'out',
                    kind: 'resend',
                    severity: 'normal',
                    detail: `resend tid=${entry.data?.tid ?? ''} attempt=${entry.data.attempt}`,
                    meta: entry.data,
                });
            } else if (entry.location === 'json.assemble') {
                const tid = entry.data?.tid;
                const agg = tid ? chunkInAgg.get(tid) : undefined;
                if (tid) chunkInAgg.delete(tid);
                // inline (single-frame) messages leave no chunk tally — keep the bare `assembled tid=…`
                const chunkSuffix = agg ? ` · ${agg.total} chunks · ${formatBytes(agg.bytes)}` : '';
                const chunkMeta = agg ? { chunks: agg.total, chunkBytes: agg.bytes } : {};
                const chunkedAt = tid ? chunkOutAt.get(tid) : undefined;
                if (chunkedAt === undefined) {
                    push({
                        direction: 'in',
                        kind: 'assemble',
                        severity: 'normal',
                        detail: `assembled tid=${tid ?? ''}${chunkSuffix}`,
                        meta: { ...entry.data, ...chunkMeta },
                    });
                } else {
                    chunkOutAt.delete(tid);
                    const elapsedMs = entry.time - chunkedAt;
                    push({
                        direction: 'in',
                        kind: 'assemble',
                        severity: 'normal',
                        detail: `assembled tid=${tid}${chunkSuffix} (+${elapsedMs}ms)`,
                        meta: { ...entry.data, ...chunkMeta, elapsedMs },
                    });
                }
                notePending();
            } else if (entry.location === 'json.partial.expired') {
                if (entry.data?.tid) {
                    chunkOutAt.delete(entry.data.tid);
                    chunkInAgg.delete(entry.data.tid);
                }
            }
        },
    };

    const onTap = (event: NetworkTapEvent) => {
        const tid = event.meta?.tid;
        if (event.kind === 'chunk-out' && tid && !chunkOutAt.has(tid)) chunkOutAt.set(tid, event.at);
        push({ direction: 'out', kind: event.kind, severity: 'normal', detail: tapDetail(event), meta: event.meta });
    };

    const teardownStack = (): void => {
        unsubMessage?.();
        unsubError?.();
        unsubInbound?.();
        transport?.detach();
        owned?.close();
        unsubMessage = undefined;
        unsubError = undefined;
        unsubInbound = undefined;
        transport = undefined;
        conditioned = undefined;
        owned = undefined;
        ws = undefined;
    };

    const buildStack = async (): Promise<void> => {
        const errScope = `connect(${id})`;
        const WS = (globalThis as any).WebSocket;
        if (typeof WS !== 'function') throw new Error(`global WebSocket is not available - ${errScope}`);
        ws = new WS(url) as WebSocketClosable;

        // reliable mode opts into the mock server's unicast handshake flag so this connection stops
        // receiving its own broadcast (self-echo) - it still relays normally to every other connection
        const connectMessage = reliableEnabled ? JSON.stringify({ action: 'connect', unicast: true }) : CONNECT_MESSAGE;
        const remoteConnectionId = await waitWebSocketConnectionId(ws, { connectMessage });
        push({
            direction: 'in',
            kind: 'handshake',
            severity: 'normal',
            detail: `connectionId=${remoteConnectionId}`,
            meta: { remoteConnectionId },
        });
        store.updateConnection(id, { remoteConnectionId, reliable: reliableEnabled });

        owned = createOwnedWebSocketNetwork({ url, socketFactory: () => ws! });
        const filtered = createFilteredNetwork(owned, raw => raw.includes('"type":"json:'));
        conditioned = createConditionedNetwork(filtered, () => condition, onTap);
        // subscribe the inbound observer before the transport attaches, so each chunk's `receive` is
        // pushed ahead of the transport's `assemble` for that frame (keeps the `chunk in ×N` fold contiguous)
        unsubInbound = conditioned.onMessage(observeInboundChunk);
        transport = createJSONTransport<Record<string, unknown>>(conditioned, {
            cleanupIntervalMs,
            partialTtlMs,
            logger,
            reliable,
        });

        unsubMessage = transport.onMessage(data => {
            push({
                direction: 'in',
                kind: 'receive',
                severity: 'normal',
                detail: preview(data),
                meta: payloadMeta(data),
            });
            notePending();
        });
        unsubError = transport.onError((error, context) => {
            const scope = context.scope;
            if (scope === 'json.partial.expired') {
                push({
                    direction: 'sys',
                    kind: 'expired',
                    severity: 'error',
                    detail: errorDetail(error, scope),
                    meta: { scope },
                });
            } else if (scope === CLOSE_SCOPE) {
                push({
                    direction: 'sys',
                    kind: 'close',
                    severity: 'normal',
                    detail: `remote closed - ${scope}`,
                    meta: { scope },
                });
                store.updateConnection(id, { status: 'closed' });
            } else if (scope === 'json.reliable.failed' || scope === 'json.error') {
                // reliable mode's unrecoverable outcome: sender exhausted maxAttempts (json.reliable.failed)
                // or the receiver was told to give up via a json:error packet (json.error)
                push({
                    direction: 'sys',
                    kind: 'reliable-fail',
                    severity: 'error',
                    detail: errorDetail(error, scope),
                    meta: { scope },
                });
            } else {
                push({
                    direction: 'sys',
                    kind: 'error',
                    severity: 'error',
                    detail: errorDetail(error, scope),
                    meta: { scope },
                });
            }
            notePending();
        });

        push({ direction: 'sys', kind: 'open', severity: 'normal', detail: `connected ${url}` });
        store.updateConnection(id, { status: 'open' });
    };

    /** reliable mode returns a Promise settling on completion (ack) or failure (maxAttempts exhausted) */
    const doSend = (payload: unknown, kind: 'send' | 'post'): void | Promise<void> => {
        const errScope = `doSend(${id})`;
        if (!transport) throw new Error(`not connected - ${errScope}`);
        push({ direction: 'out', kind, severity: 'normal', detail: preview(payload), meta: payloadMeta(payload) });
        try {
            return transport.send(payload as Record<string, unknown>);
        } catch {
            // transport.send() already reported this via onError ('json.send' scope); avoid a duplicate event.
        } finally {
            notePending();
        }
    };

    return {
        connect: () => buildStack(),

        close: () => {
            teardownStack();
            store.updateConnection(id, { status: 'closed' });
            push({ direction: 'sys', kind: 'close', severity: 'normal', detail: 'closed by client' });
        },

        reconnect: async () => {
            teardownStack();
            store.updateConnection(id, { status: 'connecting', remoteConnectionId: undefined, pendingCount: 0 });
            await buildStack();
            push({ direction: 'sys', kind: 'reconnect', severity: 'normal', detail: `reconnected ${url}` });
        },

        send: async (payload: unknown) => {
            // reliable mode: awaits the returned Promise so ack/maxAttempts-exhausted surfaces here too
            await doSend(payload, 'send');
        },

        post: (payload: unknown) => {
            doSend(payload, 'post');
        },

        configure: (next: VerifierCondition) => {
            condition = { ...next };
            store.updateConnection(id, { condition });
            push({ direction: 'sys', kind: 'configure', severity: 'normal', detail: conditionDetail(condition) });
        },

        getPrimaryNetwork: () => owned,

        armForceDrop: (count: number) => conditioned?.armForceDrop(count),
    };
};

const formatBytes = (n: number): string => (n >= 1024 ? `~${Math.round(n / 1024)}KB` : `${n}B`);

/** one-decimal KB for a single chunk frame (`13.2KB`); aggregate sizes use the coarser `formatBytes` (`~66KB`) */
const formatKB = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

/** compact preview: small payloads verbatim, large ones summarized by field size (`{big: ~66KB}`) so a 65KB blob never floods a timeline row */
const preview = (payload: unknown): string => {
    try {
        const text = JSON.stringify(payload);
        if (text === undefined) return String(payload);
        if (text.length <= 120) return text;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const parts = Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
                const valueText = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
                return valueText.length > 48 ? `${key}: ${formatBytes(valueText.length)}` : `${key}: ${valueText}`;
            });
            return `{${parts.join(', ')}}`;
        }
        return `${text.slice(0, 80)}… (${formatBytes(text.length)})`;
    } catch {
        return String(payload);
    }
};

/** per-event cap on the retained pretty-printed payload; a flood of large frames can't grow memory past this per row */
const MAX_STORED_PAYLOAD = 512 * 1024;

/**
 * retain the full pretty-printed payload on the event meta so the timeline can render a click-to-inspect
 * detail (JSON.stringify(value, null, 2)). Payloads over MAX_STORED_PAYLOAD keep only the leading slice and
 * flag `payloadTruncated` so the UI disables the (now-incomplete) copy button; `payloadBytes` is the full size.
 */
const payloadMeta = (value: unknown): Record<string, any> => {
    let text: string;
    try {
        text = JSON.stringify(value, null, 2);
    } catch {
        text = String(value);
    }
    if (text === undefined) text = String(value);
    const bytes = text.length;
    if (bytes > MAX_STORED_PAYLOAD) {
        return { payload: text.slice(0, MAX_STORED_PAYLOAD), payloadBytes: bytes, payloadTruncated: true };
    }
    return { payload: text, payloadBytes: bytes, payloadTruncated: false };
};

const errorDetail = (error: any, scope: string): string => `${error?.message ?? error} - ${scope}`;

const conditionDetail = (condition: VerifierCondition): string =>
    `latencyMs=${condition.latencyMs} jitterMs=${condition.jitterMs} unordered=${condition.unordered} maxPacketBytes=${condition.maxPacketBytes} dropRate=${condition.dropRate} corruptRate=${condition.corruptRate}`;

const tapDetail = (event: NetworkTapEvent): string => {
    if (event.kind === 'drop') {
        if (typeof event.meta?.index === 'number')
            return `dropped chunk ${event.meta.index}/${event.meta.total} tid=${event.meta.tid} (${
                typeof event.meta.bytes === 'number' ? formatKB(event.meta.bytes) : '?'
            })`;
        return `dropped ${event.meta?.bytes ?? '?'} bytes`;
    }
    if (event.kind === 'corrupt')
        return `corrupted chunk ${event.meta?.index}/${event.meta?.total} tid=${event.meta?.tid}`;
    return `chunk out ${event.meta?.index}/${event.meta?.total} tid=${event.meta?.tid} (${
        typeof event.meta?.bytes === 'number' ? formatKB(event.meta.bytes) : '?'
    })`;
};
