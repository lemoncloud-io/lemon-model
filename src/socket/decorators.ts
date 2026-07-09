/**
 * `socket/decorators.ts`
 * - L1 `NetworkSupportable` decorators: reconnect-on-death wrapper and raw wire translator.
 * - same slot as `createFilteredNetwork`; compose freely: filtered(translated(reconnecting(factory))).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkMessageHandler,
    NetworkSupportable,
    SocketErrorContext,
    SocketErrorHandler,
    SocketNetworkOptions,
    SocketReadyState,
    SocketUnsubscribe,
} from './types';
import { WEBSOCKET_NETWORK_SCOPE } from './websocket';

export interface ReconnectOptions {
    /** first retry delay (default 1_000ms) */
    baseMs?: number;
    /** exponential backoff multiplier (default 2) */
    factor?: number;
    /** retry delay cap (default 30_000ms) */
    maxMs?: number;
    /** retry count cap (default unlimited). onError notified then permanently closed once reached */
    maxRetries?: number;
    /** force a reconnect when nothing has been received for this long (default off) */
    idleTimeoutMs?: number;
    /** readyState watchdog cadence (default 1_000ms). fallback for networks that close without notifying */
    watchdogMs?: number;
}

export interface ReconnectingNetworkSupportable extends NetworkSupportable {
    /** notified on every successful reconnect (initial connect excluded). the service catches up here with machine.tick() */
    onReconnect(handler: () => void): SocketUnsubscribe;
    /** internal network generation (0 initially, +1 per reconnect) */
    readonly generation: number;
}

/**
 * default watchdog cadence for readyState-based death detection.
 * needed because an in-memory `Network.close()` notifies no one (see `socket/socket.ts`); only a
 * real `OwnedWebSocketNetwork`/`BrowserWebSocketNetwork` close notifies via `onError` (see below),
 * so the watchdog is a fallback and can stay slow — 1s keeps idle browser cost negligible.
 */
const DEFAULT_WATCHDOG_MS = 1_000;

/** create the L1 reconnect decorator: swaps the internal network on death, keeping instance identity for L3 */
export const createReconnectingNetwork = (
    factory: () => NetworkSupportable,
    options?: ReconnectOptions,
): ReconnectingNetworkSupportable => new ReconnectingNetwork(factory, options);

/** `NetworkSupportable` decorator that transparently swaps its internal network on death */
class ReconnectingNetwork implements ReconnectingNetworkSupportable {
    private readonly baseMs: number;
    private readonly factor: number;
    private readonly maxMs: number;
    private readonly maxRetries?: number;
    private readonly idleTimeoutMs?: number;

    private current: NetworkSupportable;
    private _generation = 0;
    /** connected: 정상 감시 | connecting: 후보 open 대기 | backoff: 재시도 대기 | closed: 영구 종료 */
    private phase: 'connected' | 'connecting' | 'backoff' | 'closed' = 'connected';
    private retryCount = 0;
    private delayMs: number;
    private lastMessageAt = Date.now();
    private configured?: SocketNetworkOptions;

    private unsubscribeMessage?: SocketUnsubscribe;
    private unsubscribeError?: SocketUnsubscribe;
    private unsubscribeCandidateOpen?: SocketUnsubscribe;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private readonly watchdogTimer: ReturnType<typeof setInterval>;

    private readonly messageHandlers = new Set<NetworkMessageHandler>();
    private readonly errorHandlers = new Set<SocketErrorHandler>();
    private readonly reconnectHandlers = new Set<() => void>();

    public constructor(private readonly factory: () => NetworkSupportable, options?: ReconnectOptions) {
        this.baseMs = options?.baseMs ?? 1_000;
        this.factor = options?.factor ?? 2;
        this.maxMs = options?.maxMs ?? 30_000;
        this.maxRetries = options?.maxRetries;
        this.idleTimeoutMs = options?.idleTimeoutMs;
        this.delayMs = this.baseMs;
        this.current = factory();
        this.attach(this.current);
        this.watchdogTimer = setInterval(() => this.watch(), options?.watchdogMs ?? DEFAULT_WATCHDOG_MS);
    }

    /** internal network generation (0 initially, +1 per reconnect) */
    public get generation(): number {
        return this._generation;
    }

    public get readyState(): SocketReadyState {
        return this.phase === 'closed' ? 'closed' : this.current.readyState;
    }

    public ready(): Promise<void> {
        return this.current.ready?.() ?? Promise.resolve();
    }

    public onOpen(handler: () => void): SocketUnsubscribe {
        return this.current.onOpen?.(handler) ?? (() => undefined);
    }

    /** while disconnected (mid-reconnect or permanently closed) this throws synchronously; no send queuing */
    public send(data: string): void {
        if (this.phase === 'closed') throw new Error(`@network is closed - reconnectingNetwork.send`);
        if (this.current.readyState !== 'open') {
            throw new Error(`@network is not connected - reconnectingNetwork.send`);
        }
        this.current.send(data);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }

    public onReconnect(handler: () => void): SocketUnsubscribe {
        this.reconnectHandlers.add(handler);
        return () => this.reconnectHandlers.delete(handler);
    }

    /** options are remembered and re-applied to every reconnected generation */
    public configure(options: SocketNetworkOptions): void {
        this.configured = { ...this.configured, ...options };
        this.current.configure?.(this.configured);
    }

    /** stop reconnecting and close the internal network for good */
    public close(code?: number, reason?: string): void {
        if (this.phase === 'closed') return;
        this.phase = 'closed';
        clearInterval(this.watchdogTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.detach();
        this.current.close(code, reason);
        this.messageHandlers.clear();
        this.errorHandlers.clear();
        this.reconnectHandlers.clear();
    }

    private attach(network: NetworkSupportable): void {
        this.unsubscribeMessage = network.onMessage(raw => {
            this.lastMessageAt = Date.now();
            for (const handler of [...this.messageHandlers]) handler(raw);
        });
        this.unsubscribeError = network.onError((error, context) => {
            for (const handler of [...this.errorHandlers]) handler(error, { ...context, network: this });
            //! `OwnedWebSocketNetwork`/`BrowserWebSocketNetwork` notify a close via onError with this scope
            //! (see `WEBSOCKET_NETWORK_SCOPE` in `socket/websocket.ts`). other onError calls (e.g. delivery
            //! errors) are forwarded above but do not by themselves mean the network died.
            if (
                context.scope === WEBSOCKET_NETWORK_SCOPE.ownedClose ||
                context.scope === WEBSOCKET_NETWORK_SCOPE.browserClose
            ) {
                this.onInnerDeath();
            }
        });
    }

    private detach(): void {
        this.unsubscribeMessage?.();
        this.unsubscribeError?.();
        this.unsubscribeCandidateOpen?.();
    }

    private onInnerDeath(): void {
        if (this.phase === 'connected') this.beginBackoff();
        else if (this.phase === 'connecting')
            this.failAttempt(
                new Error(`@candidate network died before open - reconnectingNetwork`),
                'reconnectingNetwork.connect',
            );
    }

    /** watchdog fallback for networks that close without notifying (e.g. in-memory `Network.close()`) */
    private watch(): void {
        const state = this.current.readyState;
        if (this.phase === 'connected') {
            if (state === 'closing' || state === 'closed') return this.beginBackoff();
            if (this.idleTimeoutMs && Date.now() - this.lastMessageAt > this.idleTimeoutMs) this.beginBackoff();
            return;
        }
        if (this.phase === 'connecting') {
            if (state === 'open') return this.settleReconnected(); // onOpen 없는 network용 fallback
            if (state === 'closing' || state === 'closed') this.onInnerDeath();
        }
    }

    private beginBackoff(): void {
        this.detach();
        this.phase = 'backoff';
        this.reconnectTimer = setTimeout(() => this.attemptReconnect(), this.delayMs);
    }

    private attemptReconnect(): void {
        if (this.phase === 'closed') return;
        if (this.maxRetries != null && this.retryCount >= this.maxRetries) {
            this.phase = 'closed';
            clearInterval(this.watchdogTimer);
            const error = new Error(`@network exceeded maxRetries[${this.maxRetries}] - reconnectingNetwork`);
            for (const handler of [...this.errorHandlers])
                handler(error, { scope: 'reconnectingNetwork.maxRetries', network: this });
            this.messageHandlers.clear();
            this.errorHandlers.clear();
            this.reconnectHandlers.clear();
            return;
        }

        let next: NetworkSupportable;
        try {
            next = this.factory();
        } catch (e) {
            this.failAttempt(e, 'reconnectingNetwork.factory');
            return;
        }

        this.current = next;
        this.attach(next);
        if (this.configured) next.configure?.(this.configured);
        this.phase = 'connecting';

        //! success is declared only once the candidate actually OPENS. a factory return alone is not a
        //! connection (a real WebSocket constructs fine while the server is down), so resetting backoff
        //! here would degrade to a constant-rate reconnect storm with an onReconnect/tick per attempt.
        const state = next.readyState;
        if (state === 'open') return this.settleReconnected();
        if (state === 'closing' || state === 'closed') return this.onInnerDeath();
        this.unsubscribeCandidateOpen = next.onOpen?.(() => {
            if (this.phase === 'connecting' && this.current === next) this.settleReconnected();
        });
        //! a candidate stuck in 'connecting' is bounded by the inner network's own connect timeout
        //! (e.g. `OwnedWebSocketNetwork.connectTimeoutMs`), which actual-closes and lands in onInnerDeath.
    }

    /** a reconnect attempt failed (factory throw, or candidate died before open): keep growing the backoff */
    private failAttempt(error: any, scope: string): void {
        this.detach();
        this.retryCount++;
        this.delayMs = Math.min(this.delayMs * this.factor, this.maxMs);
        for (const handler of [...this.errorHandlers]) handler(error, { scope, network: this });
        this.phase = 'backoff';
        this.reconnectTimer = setTimeout(() => this.attemptReconnect(), this.delayMs);
    }

    /** the candidate opened: only now reset the backoff/retry budget and notify onReconnect */
    private settleReconnected(): void {
        this.unsubscribeCandidateOpen?.();
        this.unsubscribeCandidateOpen = undefined;
        this.phase = 'connected';
        this._generation++;
        this.retryCount = 0;
        this.delayMs = this.baseMs;
        this.lastMessageAt = Date.now();
        for (const handler of [...this.reconnectHandlers]) handler();
    }
}

export interface WireTranslator {
    /** outbound raw transform (default passthrough) */
    outbound?: (raw: string) => string;
    /** inbound raw transform. returning undefined drops the raw (default passthrough) */
    inbound?: (raw: string) => string | undefined;
}

/** create the L1 wire translator decorator over a raw string, same slot as `createFilteredNetwork` */
export const createTranslatedNetwork = (source: NetworkSupportable, translator: WireTranslator): NetworkSupportable =>
    new TranslatedNetwork(source, translator);

/** `NetworkSupportable` decorator that translates raw strings at the wire boundary */
class TranslatedNetwork implements NetworkSupportable {
    private readonly errorHandlers = new Set<SocketErrorHandler>();
    private readonly unsubscribeSourceError: SocketUnsubscribe;

    public constructor(private readonly source: NetworkSupportable, private readonly translator: WireTranslator) {
        this.unsubscribeSourceError = source.onError((error, context) => this.emitError(error, context));
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

    public send(data: string): void {
        this.source.send(this.translator.outbound ? this.translator.outbound(data) : data);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        return this.source.onMessage(raw => {
            let translated: string | undefined;
            try {
                translated = this.translator.inbound ? this.translator.inbound(raw) : raw;
            } catch (e) {
                this.emitError(e, { scope: 'translatedNetwork.inbound' });
                return;
            }
            if (translated === undefined) return; // dropped by translator
            handler(translated);
        });
    }

    public configure(options: SocketNetworkOptions): void {
        this.source.configure?.(options);
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }

    public close(code?: number, reason?: string): void {
        this.unsubscribeSourceError();
        this.errorHandlers.clear();
        this.source.close(code, reason);
    }

    private emitError(error: any, context: Omit<SocketErrorContext, 'network'>): void {
        for (const handler of [...this.errorHandlers]) handler(error, { ...context, network: this });
    }
}
