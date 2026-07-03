/**
 * `sync/client.ts`
 * - L3 socket client runtime: envelope encode/decode, mid-based request/response tracking, type-based routing.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    createFilteredNetwork,
    NetworkSupportable,
    SocketErrorContext,
    SocketErrorHandler,
    SocketMessage,
    SocketUnsubscribe,
} from '../socket';
import {
    SocketClientIdentityProvider,
    SocketClientOptions,
    SocketClientSupportable,
    SocketRequestOptions,
} from './types';

interface PendingRequest {
    type: string;
    resolve: (data: any) => void;
    reject: (error: any) => void;
    timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
let midNo = 0;

/** default mid generator */
export const defaultSocketClientIdentityProvider: SocketClientIdentityProvider = {
    nextMid: () => `sync-${++midNo}`,
};

/** create the L3 socket client runtime over a shared network */
export const createSocketClient = (
    network: NetworkSupportable,
    options?: SocketClientOptions,
): SocketClientSupportable => new SocketClient(network, options);

/** L3 runtime: request/response tracking (with timeout) + type routing over one `NetworkSupportable` */
class SocketClient implements SocketClientSupportable {
    public readonly network: NetworkSupportable;
    private readonly timeoutMs: number;
    private readonly maxPending?: number;
    private readonly identity: SocketClientIdentityProvider;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly typeListeners = new Map<string, Set<(data: any, message: SocketMessage) => void>>();
    private readonly messageListeners = new Set<(message: SocketMessage) => void>();
    private readonly errorListeners = new Set<SocketErrorHandler>();
    private readonly unsubscribeNetworkMessage: SocketUnsubscribe;
    private readonly unsubscribeNetworkError: SocketUnsubscribe;
    private closed = false;

    public constructor(source: NetworkSupportable, options?: SocketClientOptions) {
        this.network = options?.filter ? createFilteredNetwork(source, options.filter) : source;
        this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxPending = options?.maxPending;
        this.identity = options?.identity ?? defaultSocketClientIdentityProvider;
        this.unsubscribeNetworkMessage = this.network.onMessage(raw => this.receive(raw));
        this.unsubscribeNetworkError = this.network.onError((error, context) => this.emitError(error, context));
    }

    /** number of requests awaiting a response */
    public get pendingCount(): number {
        return this.pending.size;
    }

    /** delegate network ready */
    public ready(): Promise<void> {
        return this.network.ready?.() ?? Promise.resolve();
    }

    /** send a request and wait for the result/error of the same mid */
    public request<T = any, R = any>(type: string, data: T, options?: SocketRequestOptions): Promise<R> {
        return new Promise<R>((resolve, reject) => {
            if (this.closed) {
                reject(new Error(`@socketClient is closed - socketClient.request(${type})`));
                return;
            }
            if (this.maxPending != null && this.pending.size >= this.maxPending) {
                reject(
                    new Error(
                        `@pending[${this.pending.size}] exceeds maxPending[${this.maxPending}] - socketClient.request(${type})`,
                    ),
                );
                return;
            }

            const mid = this.identity.nextMid();
            const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.pending.delete(mid);
                          const error = new Error(
                              `@request[${type}:${mid}] timeout(${timeoutMs}ms) - socketClient.request`,
                          );
                          this.emitError(error, { scope: 'socketClient.request.timeout', mid });
                          reject(error);
                      }, timeoutMs)
                    : undefined;
            this.pending.set(mid, { type, resolve, reject, timer });

            try {
                this.network.send(JSON.stringify({ type, data, mid }));
            } catch (e) {
                this.pending.delete(mid);
                if (timer) clearTimeout(timer);
                reject(e);
            }
        });
    }

    /** one-way send without waiting for a response */
    public post<T = any>(type: string, data: T): void {
        if (this.closed) throw new Error(`@socketClient is closed - socketClient.post(${type})`);
        const mid = this.identity.nextMid();
        try {
            this.network.send(JSON.stringify({ type, data, mid }));
        } catch (e) {
            this.emitError(e, { scope: 'socketClient.post', mid });
        }
    }

    /** subscribe to events of a specific type */
    public onType<T = any>(type: string, handler: (data: T, message: SocketMessage<T>) => void): SocketUnsubscribe {
        let listeners = this.typeListeners.get(type);
        if (!listeners) {
            listeners = new Set();
            this.typeListeners.set(type, listeners);
        }
        const set = listeners;
        set.add(handler);
        return () => set.delete(handler);
    }

    /** subscribe to inbound envelopes not matched to a pending request */
    public onMessage(handler: (message: SocketMessage) => void): SocketUnsubscribe {
        this.messageListeners.add(handler);
        return () => this.messageListeners.delete(handler);
    }

    /** observe asynchronous errors (timeout, send failure, network error) */
    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorListeners.add(handler);
        return () => this.errorListeners.delete(handler);
    }

    /** reject all pending + detach listeners. does not close network (socket is shared) */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribeNetworkMessage();
        this.unsubscribeNetworkError();
        for (const [mid, request] of this.pending) {
            if (request.timer) clearTimeout(request.timer);
            request.reject(new Error(`@socketClient is closed - socketClient.close(${mid})`));
        }
        this.pending.clear();
        this.typeListeners.clear();
        this.messageListeners.clear();
        this.errorListeners.clear();
    }

    private receive(raw: string): void {
        let message: SocketMessage;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
            message = parsed as SocketMessage;
        } catch {
            return; // not our envelope shape (e.g. json:* packet, progress string); ignore quietly
        }

        if (message.type === 'result' || message.type === 'error') {
            const pending = this.pending.get(message.mid);
            if (!pending) return; // unmatched result/error: late response, drop silently
            this.pending.delete(message.mid);
            if (pending.timer) clearTimeout(pending.timer);
            if (message.type === 'result') pending.resolve(message.data);
            else pending.reject(message.data);
            return;
        }

        for (const listener of [...this.messageListeners]) listener(message);
        const typeListeners = this.typeListeners.get(message.type);
        if (typeListeners) for (const listener of [...typeListeners]) listener(message.data, message);
    }

    private emitError(error: any, context: Omit<SocketErrorContext, 'network'>): void {
        for (const listener of [...this.errorListeners]) listener(error, { ...context, network: this.network });
    }
}
