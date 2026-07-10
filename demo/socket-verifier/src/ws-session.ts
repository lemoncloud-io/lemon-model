/**
 * mode B (real WebSocket) verifier session: assembles the network stack in the handshake ->
 * owned -> filtered -> conditioned -> JSONTransport order (02-design.md wiring) and converts every
 * observable event (tap/logger/onError) into `TimelineEvent`s. Reconnect recreates the whole stack
 * (01-spec key decision 5); `ping` is intentionally left unimplemented (mode 'peer' only).
 */
import type { SocketLogEntry, SocketLogger } from '@socket/types';
import {
    createFilteredNetwork,
    createOwnedWebSocketNetwork,
    waitWebSocketConnectionId,
    WEBSOCKET_NETWORK_SCOPE,
    type OwnedWebSocketNetwork,
    type WebSocketClosable,
} from '@socket/websocket';
import { createJSONTransport, type JSONTransport } from '@socket/transport';
import { createConditionedNetwork } from './conditioned-network';
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
    /** defaults: cleanupIntervalMs 1000, partialTtlMs 10000 (01-spec reassembly state model) */
    transportOptions?: { cleanupIntervalMs?: number; partialTtlMs?: number };
}

/** create a mode 'ws' `VerifierSession` over a real WebSocket */
export const createWsSession = (options: CreateWsSessionOptions): VerifierSession => {
    const { id, url, store } = options;
    const cleanupIntervalMs = options.transportOptions?.cleanupIntervalMs ?? 1000;
    const partialTtlMs = options.transportOptions?.partialTtlMs ?? 10000;

    let condition: VerifierCondition = { ...DEFAULT_VERIFIER_CONDITION };
    let ws: WebSocketClosable | undefined;
    let owned: OwnedWebSocketNetwork | undefined;
    let transport: JSONTransport<Record<string, unknown>> | undefined;
    let unsubMessage: (() => void) | undefined;
    let unsubError: (() => void) | undefined;
    /** tid -> first chunk-out time, scoped to chunked round-trips only (non-chunked receives stay out of scope) */
    const chunkOutAt = new Map<string, number>();

    const push = (event: Omit<NewTimelineEvent, 'connectionId'>) => store.pushEvent({ connectionId: id, ...event });
    const notePending = () => transport && store.notePendingCount(id, transport.pendingCount);

    /** unknown log locations are ignored on purpose (design risk: transport refactors may drop kinds) */
    const logger: SocketLogger = {
        log: (entry: SocketLogEntry) => {
            if (entry.location === 'json.receive') {
                push({
                    direction: 'in',
                    kind: 'receive',
                    severity: 'normal',
                    detail: `packet ${entry.data?.type ?? ''} tid=${entry.data?.tid ?? ''}`,
                    meta: entry.data,
                });
                // transport logs 'json.receive' before it updates its internal pending state for this packet
                // (transport.ts:437 precedes acceptPacket); defer so pendingCount reflects this packet too
                queueMicrotask(notePending);
            } else if (entry.location === 'json.assemble') {
                const tid = entry.data?.tid;
                const chunkedAt = tid ? chunkOutAt.get(tid) : undefined;
                if (chunkedAt === undefined) {
                    push({
                        direction: 'in',
                        kind: 'assemble',
                        severity: 'normal',
                        detail: `assembled tid=${tid ?? ''}`,
                        meta: entry.data,
                    });
                } else {
                    chunkOutAt.delete(tid);
                    const elapsedMs = entry.time - chunkedAt;
                    push({
                        direction: 'in',
                        kind: 'assemble',
                        severity: 'normal',
                        detail: `assembled tid=${tid} (+${elapsedMs}ms)`,
                        meta: { ...entry.data, elapsedMs },
                    });
                }
                notePending();
            } else if (entry.location === 'json.partial.expired') {
                if (entry.data?.tid) chunkOutAt.delete(entry.data.tid);
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
        transport?.detach();
        owned?.close();
        unsubMessage = undefined;
        unsubError = undefined;
        transport = undefined;
        owned = undefined;
        ws = undefined;
    };

    const buildStack = async (): Promise<void> => {
        const errScope = `connect(${id})`;
        const WS = (globalThis as any).WebSocket;
        if (typeof WS !== 'function') throw new Error(`global WebSocket is not available - ${errScope}`);
        ws = new WS(url) as WebSocketClosable;

        const remoteConnectionId = await waitWebSocketConnectionId(ws, { connectMessage: CONNECT_MESSAGE });
        push({
            direction: 'in',
            kind: 'handshake',
            severity: 'normal',
            detail: `connectionId=${remoteConnectionId}`,
            meta: { remoteConnectionId },
        });
        store.updateConnection(id, { remoteConnectionId });

        owned = createOwnedWebSocketNetwork({ url, socketFactory: () => ws! });
        const filtered = createFilteredNetwork(owned, raw => raw.includes('"type":"json:'));
        const conditioned = createConditionedNetwork(filtered, () => condition, onTap);
        transport = createJSONTransport<Record<string, unknown>>(conditioned, {
            cleanupIntervalMs,
            partialTtlMs,
            logger,
        });

        unsubMessage = transport.onMessage(data => {
            push({ direction: 'in', kind: 'receive', severity: 'normal', detail: preview(data) });
            notePending();
        });
        unsubError = transport.onError((error, context) => {
            const scope = context.scope;
            if (scope === 'json.partial.expired') {
                push({ direction: 'sys', kind: 'expired', severity: 'error', detail: errorDetail(error, scope), meta: { scope } });
            } else if (scope === CLOSE_SCOPE) {
                push({ direction: 'sys', kind: 'close', severity: 'normal', detail: `remote closed - ${scope}`, meta: { scope } });
                store.updateConnection(id, { status: 'closed' });
            } else {
                push({ direction: 'sys', kind: 'error', severity: 'error', detail: errorDetail(error, scope), meta: { scope } });
            }
            notePending();
        });

        push({ direction: 'sys', kind: 'open', severity: 'normal', detail: `connected ${url}` });
        store.updateConnection(id, { status: 'open' });
    };

    const doSend = (payload: unknown, kind: 'send' | 'post'): void => {
        const errScope = `doSend(${id})`;
        if (!transport) throw new Error(`not connected - ${errScope}`);
        push({ direction: 'out', kind, severity: 'normal', detail: preview(payload) });
        try {
            transport.send(payload as Record<string, unknown>);
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
            doSend(payload, 'send');
        },

        post: (payload: unknown) => {
            doSend(payload, 'post');
        },

        configure: (next: VerifierCondition) => {
            condition = { ...next };
            store.updateConnection(id, { condition });
            push({ direction: 'sys', kind: 'configure', severity: 'normal', detail: conditionDetail(condition) });
        },
    };
};

const preview = (payload: unknown): string => {
    try {
        const text = JSON.stringify(payload);
        return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    } catch {
        return String(payload);
    }
};

const errorDetail = (error: any, scope: string): string => `${error?.message ?? error} - ${scope}`;

const conditionDetail = (condition: VerifierCondition): string =>
    `latencyMs=${condition.latencyMs} jitterMs=${condition.jitterMs} unordered=${condition.unordered} maxPacketBytes=${condition.maxPacketBytes} dropRate=${condition.dropRate} corruptRate=${condition.corruptRate}`;

const tapDetail = (event: NetworkTapEvent): string => {
    if (event.kind === 'drop') return `dropped ${event.meta?.bytes ?? '?'} bytes`;
    if (event.kind === 'corrupt') return `corrupted chunk ${event.meta?.index}/${event.meta?.total} tid=${event.meta?.tid}`;
    return `chunk ${event.meta?.index}/${event.meta?.total} tid=${event.meta?.tid} (${event.meta?.bytes ?? '?'} bytes)`;
};
