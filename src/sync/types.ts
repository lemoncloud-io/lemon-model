/**
 * `sync/types.ts`
 * - public contracts for the model sync client: L3 socket client runtime + L4 sync machine.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkSupportable,
    RawOwnershipPredicate,
    SocketErrorHandler,
    SocketMessage,
    SocketUnsubscribe,
} from '../socket';

/**
 * minimal contract a sync target must satisfy — the machine only ever reads these three fields.
 * `CoreModel` satisfies this automatically; any external model with id/updatedAt qualifies too.
 */
export interface SyncTarget {
    /** unique id */
    id?: string;
    /** last-modified timestamp (ms) — the freshness criterion */
    updatedAt?: number;
    /** deleted timestamp (ms) — presence removes the model from the store */
    deletedAt?: number;
}

/** mid generator */
export interface SocketClientIdentityProvider {
    nextMid(): string;
}

export interface SocketClientOptions {
    /** request-response wait limit (default 15_000ms) */
    timeoutMs?: number;
    /** concurrent pending cap. request() beyond this rejects immediately (default unlimited) */
    maxPending?: number;
    /** ownership decision over raw strings this runtime handles. wrapped internally with createFilteredNetwork */
    filter?: RawOwnershipPredicate;
    /** mid generator (default provided) */
    identity?: SocketClientIdentityProvider;
}

export interface SocketRequestOptions {
    /** timeout override for this request only */
    timeoutMs?: number;
}

export interface SocketClientSupportable {
    /** underlying network (shared socket) */
    readonly network: NetworkSupportable;
    /** number of requests awaiting a response */
    readonly pendingCount: number;
    /** delegate network ready */
    ready(): Promise<void>;
    /** send a request and wait for the result/error of the same mid */
    request<T = any, R = any>(type: string, data: T, options?: SocketRequestOptions): Promise<R>;
    /** one-way send without waiting for a response */
    post<T = any>(type: string, data: T): void;
    /** subscribe to events of a specific type */
    onType<T = any>(type: string, handler: (data: T, message: SocketMessage<T>) => void): SocketUnsubscribe;
    /** subscribe to inbound envelopes not matched to a pending request. unmatched result/error is treated as a late response and quietly dropped */
    onMessage(handler: (message: SocketMessage) => void): SocketUnsubscribe;
    /** observe asynchronous errors (timeout, send failure, network error) */
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    /** reject all pending + detach listeners. does not close network (socket is shared) */
    close(): void;
}

/** change notification */
export interface SyncChangeEvent<M extends SyncTarget> {
    /** cause of the change */
    cause: 'pull' | 'event';
    /** models applied or removed by this change */
    models: M[];
}

/** server-confirmed page extracted from a pull reply */
export interface SyncReplyPage<M extends SyncTarget> {
    /** server-confirmed models */
    models: M[];
    /** cursor for the next page. absent means pull is done */
    next?: any;
}

/**
 * protocol adapter — injected by the service.
 * the machine does not know the wire protocol, and the adapter does not know local state.
 */
export interface SyncProtocolAdapter<M extends SyncTarget> {
    /** build a pull request from since(updatedAt watermark) and cursor. omitted since means full pull */
    buildPull(since?: number, cursor?: any): { type: string; data: any };
    /** extract server-confirmed models and the next cursor from pull reply data */
    parseReply(data: any): SyncReplyPage<M>;
    /** extract this type's models from a server-sent event. undefined if not owned. must be a pure predicate/extractor with no side effects */
    parseEvent(message: SocketMessage): M[] | undefined;
}

export interface ModelSyncOptions<M extends SyncTarget> {
    adapter: SyncProtocolAdapter<M>;
    /** run an initial pull right after register (default true). failure still leaves register valid; the next pull/tick pulls from scratch. set false and call pull() directly to observe failures */
    initialPull?: boolean;
}

/** sync handle for a single model type */
export interface ModelSyncSupportable<M extends SyncTarget> {
    readonly type: string;
    /** read-only local state lookup */
    get(id: string): M | undefined;
    list(): M[];
    /** pull changes since the watermark and apply them. loops the cursor until parseReply.next is absent */
    pull(): Promise<M[]>;
    /** subscribe to change notifications */
    onChange(handler: (event: SyncChangeEvent<M>) => void): SocketUnsubscribe;
    /** detach this type's subscriptions/listeners */
    close(): void;
}

export interface SyncMachineSupportable {
    /** register a domain model type. re-registering the same type returns the existing handle and ignores the new options */
    register<M extends SyncTarget>(type: string, options: ModelSyncOptions<M>): ModelSyncSupportable<M>;
    /** pull every registered type once. the service calls this at whatever cadence it wants. a type whose pull is already in flight is skipped, not nested */
    tick(): Promise<void>;
    /** detach everything */
    close(): void;
}
