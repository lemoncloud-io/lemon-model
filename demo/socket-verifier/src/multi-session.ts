/**
 * Sockets-section extension for a mode 'ws' panel (02-design.md "demo/socket-verifier 확장", UX 개정).
 * Owns backup socket S1..N alongside the panel's already-connected main socket S0
 * (`ws-session.ts`'s `getPrimaryNetwork()` attach point). Every add/remove recomposes a fresh
 * `createMultiSocketNetwork([S0, S1, ...])` (01-spec Out of Scope: no runtime add/remove - the
 * configuration is fixed at construction, changing it means recreating the composite). Runs
 * **parallel** to the existing Mode B transport stack (owned -> filtered -> conditioned -> transport)
 * on S0 - never stacked under it, so raw mid frames (row Send / Send All) bypass chunking/JSONTransport
 * entirely (01-spec all-transport-unit constraint: `sendAll` is the only path that reaches every
 * socket; putting transport on top of a merged multi-socket stream would misidentify a relayed
 * chunk's tid as `json.manifest.duplicate`).
 *
 * Per-socket message/error tagging is done by subscribing to **each instance's own `onMessage`/`onError`
 * directly** rather than the composite's untagged merge (01-spec: message-level origin tagging is a
 * consumer concern, demonstrated here by subscribing the injected instances directly). Mid dedup
 * (first arrival = `receive`, re-arrival = `duplicate`) is derived once over this tagged, unified
 * stream. `"type":"json:` frames belong to S0's transport stack and are ignored. S0's own
 * remote/abnormal close is already reported by the base ws-session pipeline, so only backups' closes
 * are reported here to avoid duplicate noise.
 */
import {
    createOwnedWebSocketNetwork,
    waitWebSocketConnectionId,
    WEBSOCKET_NETWORK_SCOPE,
    type OwnedWebSocketNetwork,
    type WebSocketClosable,
} from '@socket/websocket';
import {
    createMultiSocketNetwork,
    MULTI_NETWORK_SCOPE,
    type MultiNetworkSupportable,
    type MultiSocketErrorContext,
} from '@socket/multi';
import type { NetworkSupportable, SocketErrorContext, SocketUnsubscribe } from '@socket/types';
import type { NewTimelineEvent, VerifierStore } from './verifier-store';
import type { SocketRowState } from './types';

const CONNECT_MESSAGE = '{"action":"connect"}';
/** frames owned by S0's transport stack (json:chunk/json:manifest/...); this session only cares about mid frames */
const isTransportFrame = (raw: string): boolean => raw.includes('"type":"json:');

export interface CreateMultiSessionOptions {
    id: string;
    store: VerifierStore;
    /** the panel's main network (ws-session.ts's `getPrimaryNetwork()`); becomes socket index 0 (S0) */
    primary: NetworkSupportable;
    /** display url for the S0 row; cosmetic only (the network itself is already connected) */
    mainUrl: string;
}

export interface MultiSession {
    /** connect a new backup socket at `url`, then recompose; a stale call (raced by detach()) discards itself */
    addSocket(url: string): Promise<void>;
    /** close backup socket `index` (>=1) and remove it from the configuration, then recompose */
    removeSocket(index: number): void;
    /** close socket `index` in place without removing it from the configuration (S0 also breaks transport Send) */
    closeSocket(index: number): void;
    /** raw single-socket send: the injected instance's own `send(mid frame)`, bypassing transport even for S0 */
    sendOne(index: number, payload: unknown): void;
    /** send the same mid frame to every configured socket via the multi composite; requires >=1 backup */
    sendAll(payload: unknown): void;
    /** tear down: close every backup socket and unsubscribe (S0 itself is left untouched - owned by ws-session.ts) */
    detach(): void;
}

interface BackupEntry {
    owned: OwnedWebSocketNetwork;
    url: string;
    unsubMessage: SocketUnsubscribe;
    unsubError: SocketUnsubscribe;
}

/** create the Sockets-section session for one mode 'ws' panel; S0 (primary) is live from the start */
export const createMultiSession = (options: CreateMultiSessionOptions): MultiSession => {
    const { id, store, primary, mainUrl } = options;

    const backups: BackupEntry[] = [];
    let composite: MultiNetworkSupportable | undefined;
    let unsubCompositeError: SocketUnsubscribe | undefined;
    /** bumped by detach(); an addSocket() that resolves after a bump is stale and must discard itself */
    let generation = 0;
    let midCounter = 0;
    /** mids already seen across every tagged socket stream; a re-arrival derives `duplicate` (01-spec dedup contract) */
    const seenMids = new Set<string>();

    const push = (event: Omit<NewTimelineEvent, 'connectionId'>) => store.pushEvent({ connectionId: id, ...event });
    const nextMid = (): string => `m-${(midCounter += 1)}`;
    const networkAt = (index: number): NetworkSupportable => (index === 0 ? primary : backups[index - 1].owned);
    const allNetworks = (): NetworkSupportable[] => [primary, ...backups.map(b => b.owned)];

    const syncSockets = (): void => {
        const sockets: SocketRowState[] = [
            { index: 0, url: mainUrl, status: primary.readyState },
            ...backups.map((b, i) => ({ index: i + 1, url: b.url, status: b.owned.readyState })),
        ];
        store.updateConnection(id, { sockets });
    };

    const handleTaggedMessage = (index: number) => (raw: string): void => {
        if (isTransportFrame(raw)) return; // belongs to S0's transport stack; already handled by ws-session.ts
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch {
            parsed = undefined;
        }
        const mid = parsed?.mid as string | undefined;
        if (mid && seenMids.has(mid)) {
            push({
                direction: 'in',
                kind: 'duplicate',
                severity: 'normal',
                detail: `duplicate mid=${mid}`,
                meta: { mid, socketIndex: index },
            });
            return;
        }
        if (mid) seenMids.add(mid);
        push({
            direction: 'in',
            kind: 'receive',
            severity: 'normal',
            detail: preview(parsed ?? raw),
            meta: { mid, socketIndex: index },
        });
    };

    const handleTaggedError = (index: number) => (error: any, context: SocketErrorContext): void => {
        if (context.scope === WEBSOCKET_NETWORK_SCOPE.ownedClose) {
            if (index === 0) return; // S0's remote close: already reported by ws-session.ts
            push({
                direction: 'sys',
                kind: 'close',
                severity: 'normal',
                detail: `S${index} closed remotely - ${context.scope}`,
                meta: { socketIndex: index, scope: context.scope },
            });
            syncSockets();
            return;
        }
        push({
            direction: 'sys',
            kind: 'error',
            severity: 'error',
            detail: `S${index}: ${error?.message ?? error} - ${context.scope}`,
            meta: { socketIndex: index, scope: context.scope },
        });
    };

    const unsubPrimaryMessage = primary.onMessage(handleTaggedMessage(0));
    const unsubPrimaryError = primary.onError(handleTaggedError(0));

    /** rebuild the multi composite from the current [S0, ...backups]; only exists once a backup is configured */
    const recompose = (): void => {
        unsubCompositeError?.();
        unsubCompositeError = undefined;
        composite = backups.length >= 1 ? createMultiSocketNetwork(allNetworks()) : undefined;
        if (!composite) return;
        unsubCompositeError = composite.onError((error, context) => {
            const ctx = context as MultiSocketErrorContext;
            if (ctx.scope !== MULTI_NETWORK_SCOPE.send) return; // lifecycle errors: our own per-instance subscriptions already report them
            push({
                direction: 'sys',
                kind: 'error',
                severity: 'error',
                detail: `sendAll failed (S${ctx.index}): ${error?.message ?? error} - ${ctx.scope}`,
                meta: { socketIndex: ctx.index, scope: ctx.scope },
            });
        });
    };

    syncSockets();

    return {
        addSocket: async (url: string) => {
            const startGeneration = generation;
            const errScope = `addSocket(${id})`;
            const WS = (globalThis as any).WebSocket;
            if (typeof WS !== 'function') throw new Error(`global WebSocket is not available - ${errScope}`);
            const ws = new WS(url) as WebSocketClosable;
            const remoteConnectionId = await waitWebSocketConnectionId(ws, { connectMessage: CONNECT_MESSAGE });
            const owned = createOwnedWebSocketNetwork({ url, socketFactory: () => ws });

            // detach() raced this add while the handshake was pending - discard the just-connected socket
            if (generation !== startGeneration) {
                owned.close();
                return;
            }

            const index = backups.length + 1;
            push({
                direction: 'in',
                kind: 'handshake',
                severity: 'normal',
                detail: `S${index} connectionId=${remoteConnectionId}`,
                meta: { socketIndex: index, remoteConnectionId },
            });

            const unsubMessage = owned.onMessage(handleTaggedMessage(index));
            const unsubError = owned.onError(handleTaggedError(index));
            backups.push({ owned, url, unsubMessage, unsubError });
            recompose();
            syncSockets();
        },

        removeSocket: (index: number) => {
            const errScope = `removeSocket(${id}/${index})`;
            if (index === 0) throw new Error(`cannot remove the main socket S0 - ${errScope}`);
            const entry = backups[index - 1];
            if (!entry) throw new Error(`no socket at index ${index} - ${errScope}`);
            entry.unsubMessage();
            entry.unsubError();
            entry.owned.close();
            backups.splice(index - 1, 1);
            push({ direction: 'sys', kind: 'close', severity: 'normal', detail: `S${index} removed by client`, meta: { socketIndex: index } });

            // index is only ever "current array position" - every surviving backup shifted down one
            // slot, so its direct-subscribe tagging closure (fixed at add time) must be re-subscribed
            // under its new index too, or it keeps reporting under its old number (review-caught bug:
            // row label/sendAll error use the new index, receive/duplicate/close kept reporting the old one)
            backups.forEach((survivor, i) => {
                survivor.unsubMessage();
                survivor.unsubError();
                const newIndex = i + 1;
                survivor.unsubMessage = survivor.owned.onMessage(handleTaggedMessage(newIndex));
                survivor.unsubError = survivor.owned.onError(handleTaggedError(newIndex));
            });

            recompose();
            syncSockets();
        },

        closeSocket: (index: number) => {
            networkAt(index).close();
            if (index === 0) {
                push({
                    direction: 'sys',
                    kind: 'close',
                    severity: 'normal',
                    detail: 'S0 closed by client (transport Send breaks too)',
                    meta: { socketIndex: 0 },
                });
                store.updateConnection(id, { status: 'closed' });
            } else {
                push({ direction: 'sys', kind: 'close', severity: 'normal', detail: `S${index} closed by client`, meta: { socketIndex: index } });
            }
            syncSockets();
        },

        sendOne: (index: number, payload: unknown) => {
            const mid = nextMid();
            push({ direction: 'out', kind: 'send', severity: 'normal', detail: preview(payload), meta: { mid, socketIndex: index } });
            networkAt(index).send(JSON.stringify({ mid, data: payload }));
        },

        sendAll: (payload: unknown) => {
            const errScope = `sendAll(${id})`;
            if (!composite) throw new Error(`no backup sockets configured - ${errScope}`);
            const mid = nextMid();
            push({ direction: 'out', kind: 'send', severity: 'normal', detail: `sendAll ${preview(payload)}`, meta: { mid, all: true } });
            composite.sendAll(JSON.stringify({ mid, data: payload }));
        },

        detach: () => {
            generation += 1;
            unsubPrimaryMessage();
            unsubPrimaryError();
            unsubCompositeError?.();
            unsubCompositeError = undefined;
            backups.forEach(entry => {
                entry.unsubMessage();
                entry.unsubError();
                entry.owned.close();
            });
            backups.length = 0;
            composite = undefined;
            store.updateConnection(id, { sockets: undefined });
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
