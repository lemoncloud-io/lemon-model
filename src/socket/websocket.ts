/**
 * `socket/websocket.ts`
 * - Real WebSocket adapter for `NetworkSupportable` plus connection-id handshake helpers.
 * - Runtime-neutral (browser / Node 18+ / custom UI runtimes) via the `WebSocketCompartible` contract.
 *
 * @origin eureka-agents-api / src/lib/proxy/transport.ts (generic WebSocket bridge extracted into the shared socket core)
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkMessageHandler,
    NetworkSupportable,
    SocketErrorHandler,
    SocketNetworkOptions,
    SocketReadyState,
    SocketUnsubscribe,
} from './types';

/** event map required from a browser-like WebSocket object */
export interface WebSocketCompartibleEventMap {
    open: unknown;
    close: unknown;
    error: unknown;
    message: { data: unknown };
}

/** preferred spelling for WebSocket-compatible event maps */
export type WebSocketCompatibleEventMap = WebSocketCompartibleEventMap;

/**
 * Minimal WebSocket-compatible contract.
 *
 * This keeps the socket package usable in browsers, tests, and custom UI runtimes
 * without depending directly on the DOM `WebSocket` type.
 */
export interface WebSocketCompartible {
    readonly CONNECTING?: number;
    readonly OPEN?: number;
    readonly CLOSING?: number;
    readonly CLOSED?: number;
    readonly readyState: number;
    send(data: string): void;
    addEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
        options?: { once?: boolean },
    ): void;
    removeEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
    ): void;
}

/** preferred spelling; `WebSocketCompartible` remains for backward compatibility */
export type WebSocketCompatible = WebSocketCompartible;

/** options for the standard WebSocket connection-id handshake */
export interface WebSocketConnectionIdOptions {
    /** message sent after socket open, usually `device.save` */
    connectMessage?: string;
    /** timeout for open and connection-id response */
    timeoutMs?: number;
    /** custom extractor when a service returns a different connection-id shape */
    extract?: (message: unknown) => string | undefined;
}

/** extract a connection id from known API Gateway/WebSocket handshake response shapes */
export const extractWebSocketConnectionId = (message: unknown): string | undefined => {
    if (!message || typeof message !== 'object') return undefined;
    const data = message as any;
    const candidates = [
        data.connectionId,
        data.connId,
        data.data?.connectionId,
        data.data?.connId,
        data.data?.connId?.id,
        data.data?.id,
        data.body?.connectionId,
        data.body?.connId,
        data.body?.id,
        data.id,
    ];
    return candidates.find(value => typeof value === 'string' && value.length > 0);
};

/**
 * Wait until a WebSocket is open, send the handshake message, and resolve the
 * first connection id found in inbound messages.
 */
export const waitWebSocketConnectionId = async (
    ws: WebSocketCompartible,
    options: WebSocketConnectionIdOptions = {},
): Promise<string> => {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const extract = options.extract ?? extractWebSocketConnectionId;

    await waitWebSocketOpen(ws, timeoutMs);

    return new Promise((resolve, reject) => {
        let settled = false;
        const timer =
            timeoutMs > 0
                ? setTimeout(() => {
                      rejectOnce(new Error(`timeout waiting for connectionId from WebSocket: ${timeoutMs}ms`));
                  }, timeoutMs)
                : undefined;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            ws.removeEventListener('message', onMessage);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('close', onClose);
        };
        const resolveOnce = (connectionId: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(connectionId);
        };
        const rejectOnce = (error: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onMessage = async (event: WebSocketCompartibleEventMap['message']) => {
            try {
                const raw = await asWebSocketText(event.data);
                const json = tryParseWebSocketJSON(raw);
                const connectionId = extract(json ?? raw);
                if (connectionId) resolveOnce(connectionId);
            } catch (e) {
                rejectOnce(e);
            }
        };
        const onError = (event: WebSocketCompartibleEventMap['error']) => rejectOnce(event);
        const onClose = () => rejectOnce(new Error(`WebSocket closed before connectionId was received`));

        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError, { once: true });
        ws.addEventListener('close', onClose, { once: true });
        if (options.connectMessage) ws.send(options.connectMessage);
    });
};

/**
 * Adapter from browser-like WebSocket objects to `NetworkSupportable`.
 *
 * The adapter does not own externally supplied WebSocket instances. `close()` is
 * intentionally equivalent to `detach()`; callers that created the WebSocket should
 * close it themselves when they want the underlying connection closed.
 */
export class BrowserWebSocketNetwork implements NetworkSupportable {
    private readonly messageHandlers = new Set<NetworkMessageHandler>();
    private readonly errorHandlers = new Set<SocketErrorHandler>();
    private readonly opened: Promise<void>;
    private readyOpenHandler?: (event: WebSocketCompartibleEventMap['open']) => void;
    private readyErrorHandler?: (event: WebSocketCompartibleEventMap['error']) => void;
    private detached = false;

    private readonly handleOpen = (): void => undefined;
    private readonly handleMessage = (event: WebSocketCompartibleEventMap['message']) => {
        if (this.detached || typeof event.data !== 'string') return;
        for (const handler of [...this.messageHandlers]) handler(event.data);
    };
    private readonly handleError = (event: WebSocketCompartibleEventMap['error']) => {
        if (this.detached) return;
        for (const handler of [...this.errorHandlers]) handler(event, { scope: 'browserWebSocket', network: this });
    };
    private readonly handleClose = (event: WebSocketCompartibleEventMap['close']) => {
        if (this.detached) return;
        for (const handler of [...this.errorHandlers])
            handler(event, { scope: 'browserWebSocket.close', network: this });
    };

    public constructor(private readonly ws: WebSocketCompartible) {
        this.opened = this.isOpen()
            ? Promise.resolve()
            : new Promise((resolve, reject) => {
                  const onOpen = () => {
                      this.detachReadyListeners();
                      resolve();
                  };
                  const onError = (event: WebSocketCompartibleEventMap['error']) => {
                      this.detachReadyListeners();
                      reject(event);
                  };
                  this.readyOpenHandler = onOpen;
                  this.readyErrorHandler = onError;
                  ws.addEventListener('open', onOpen, { once: true });
                  ws.addEventListener('error', onError, { once: true });
              });

        ws.addEventListener('open', this.handleOpen);
        ws.addEventListener('message', this.handleMessage);
        ws.addEventListener('error', this.handleError);
        ws.addEventListener('close', this.handleClose);
    }

    public get readyState(): SocketReadyState {
        if (this.detached) return 'closed';
        if (this.isOpen()) return 'open';
        if (this.ws.readyState === this.stateValue('CLOSING', 2)) return 'closing';
        if (this.ws.readyState === this.stateValue('CLOSED', 3)) return 'closed';
        return 'connecting';
    }

    public ready(): Promise<void> {
        if (this.detached)
            return Promise.reject(new Error(`@network connection error: closed - browserWebSocket.ready`));
        return this.opened;
    }

    public send(data: string): void {
        if (this.detached || !this.isOpen()) {
            throw new Error(`@network connection error: ${this.readyState} - browserWebSocket.send`);
        }
        this.ws.send(data);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        if (this.detached) throw new Error(`@network connection error: closed - browserWebSocket.onMessage`);
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    public configure(_options: SocketNetworkOptions): void {
        // Browser WebSocket transport options are controlled by the browser/runtime.
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }

    public close(): void {
        this.detach();
    }

    /** remove all listeners without closing the externally owned WebSocket */
    public detach(): void {
        if (this.detached) return;
        this.detached = true;
        this.messageHandlers.clear();
        this.errorHandlers.clear();
        this.ws.removeEventListener('open', this.handleOpen);
        this.ws.removeEventListener('message', this.handleMessage);
        this.ws.removeEventListener('error', this.handleError);
        this.ws.removeEventListener('close', this.handleClose);
        this.detachReadyListeners();
    }

    private isOpen(): boolean {
        return this.ws.readyState === this.stateValue('OPEN', 1);
    }

    private stateValue(key: 'OPEN' | 'CLOSING' | 'CLOSED', fallback: number): number {
        return typeof this.ws[key] === 'number' ? this.ws[key] : fallback;
    }

    private detachReadyListeners(): void {
        if (this.readyOpenHandler) this.ws.removeEventListener('open', this.readyOpenHandler);
        if (this.readyErrorHandler) this.ws.removeEventListener('error', this.readyErrorHandler);
        this.readyOpenHandler = undefined;
        this.readyErrorHandler = undefined;
    }
}

/** WebSocket-compatible contract that also exposes an actual `close()`. */
export interface WebSocketClosable extends WebSocketCompartible {
    close(code?: number, reason?: string): void;
}

/** context passed to a custom `socketFactory` when an owned WebSocket is created */
export interface OwnedWebSocketNetworkFactoryContext {
    url: string;
    protocols?: string | string[];
}

/** options for an owned WebSocket network adapter */
export interface OwnedWebSocketNetworkOptions {
    /** target WebSocket url */
    url: string;
    /** optional subprotocol(s) */
    protocols?: string | string[];
    /** custom WebSocket creation (defaults to the global `WebSocket`) */
    socketFactory?: (context: OwnedWebSocketNetworkFactoryContext) => WebSocketClosable;
    /** timeout for the initial open; on timeout the socket is actual-closed (default 15s) */
    connectTimeoutMs?: number;
}

/**
 * Adapter that owns the WebSocket it creates.
 *
 * Unlike `BrowserWebSocketNetwork`, `close()` performs an actual socket close. The adapter only
 * handles raw string send/receive, connect timeout, and event mapping; it knows nothing about
 * message parsing, pending settlement, or routing.
 */
export class OwnedWebSocketNetwork implements NetworkSupportable {
    private readonly ws: WebSocketClosable;
    private readonly openHandlers = new Set<() => void>();
    private readonly messageHandlers = new Set<NetworkMessageHandler>();
    private readonly errorHandlers = new Set<SocketErrorHandler>();
    private readonly opened: Promise<void>;
    private closed = false;

    private readonly handleOpen = () => {
        if (this.closed) return;
        for (const handler of [...this.openHandlers]) handler();
    };
    private readonly handleMessage = (event: WebSocketCompartibleEventMap['message']) => {
        if (this.closed || typeof event.data !== 'string') return;
        for (const handler of [...this.messageHandlers]) handler(event.data);
    };
    private readonly handleError = (event: WebSocketCompartibleEventMap['error']) => {
        if (this.closed) return;
        for (const handler of [...this.errorHandlers]) handler(event, { scope: 'ownedWebSocket', network: this });
    };
    private readonly handleClose = (event: WebSocketCompartibleEventMap['close']) => {
        if (this.closed) return;
        for (const handler of [...this.errorHandlers]) handler(event, { scope: 'ownedWebSocket.close', network: this });
    };

    public constructor(options: OwnedWebSocketNetworkOptions) {
        this.ws = options.socketFactory
            ? options.socketFactory({ url: options.url, protocols: options.protocols })
            : createDefaultWebSocket(options);
        this.opened = this.buildOpened(options.connectTimeoutMs ?? 15_000);
        this.ws.addEventListener('open', this.handleOpen);
        this.ws.addEventListener('message', this.handleMessage);
        this.ws.addEventListener('error', this.handleError);
        this.ws.addEventListener('close', this.handleClose);
    }

    /** subscribe to the synchronous open event (in addition to the `ready()` promise) */
    public onOpen(handler: () => void): SocketUnsubscribe {
        if (this.closed) throw new Error(`@network connection error: closed - ownedWebSocket.onOpen`);
        this.openHandlers.add(handler);
        return () => this.openHandlers.delete(handler);
    }

    public get readyState(): SocketReadyState {
        if (this.closed) return 'closed';
        if (this.isOpen()) return 'open';
        if (this.ws.readyState === stateValue(this.ws, 'CLOSING', 2)) return 'closing';
        if (this.ws.readyState === stateValue(this.ws, 'CLOSED', 3)) return 'closed';
        return 'connecting';
    }

    public ready(): Promise<void> {
        if (this.closed) return Promise.reject(new Error(`@network connection error: closed - ownedWebSocket.ready`));
        return this.opened;
    }

    public send(data: string): void {
        if (this.closed || !this.isOpen()) {
            throw new Error(`@network connection error: ${this.readyState} - ownedWebSocket.send`);
        }
        this.ws.send(data);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        if (this.closed) throw new Error(`@network connection error: closed - ownedWebSocket.onMessage`);
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    public configure(_options: SocketNetworkOptions): void {
        // Owned WebSocket transport options are controlled by the runtime.
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }

    public close(code?: number, reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        this.openHandlers.clear();
        this.messageHandlers.clear();
        this.errorHandlers.clear();
        this.ws.removeEventListener('open', this.handleOpen);
        this.ws.removeEventListener('message', this.handleMessage);
        this.ws.removeEventListener('error', this.handleError);
        this.ws.removeEventListener('close', this.handleClose);
        try {
            this.ws.close(code, reason);
        } catch {
            // ignore close errors; the adapter is already detached
        }
    }

    private buildOpened(timeoutMs: number): Promise<void> {
        if (this.isOpen()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          rejectOnce(new Error(`timeout waiting for WebSocket open: ${timeoutMs}ms`));
                          this.close();
                      }, timeoutMs)
                    : undefined;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this.ws.removeEventListener('open', onOpen);
                this.ws.removeEventListener('error', onError);
                this.ws.removeEventListener('close', onClose);
            };
            const resolveOnce = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const rejectOnce = (error: any) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const onOpen = () => resolveOnce();
            const onError = (event: WebSocketCompartibleEventMap['error']) => rejectOnce(event);
            const onClose = () => rejectOnce(new Error(`WebSocket closed before open`));
            this.ws.addEventListener('open', onOpen, { once: true });
            this.ws.addEventListener('error', onError, { once: true });
            this.ws.addEventListener('close', onClose, { once: true });
        });
    }

    private isOpen(): boolean {
        return this.ws.readyState === stateValue(this.ws, 'OPEN', 1);
    }
}

/** create an owned WebSocket network adapter */
export const createOwnedWebSocketNetwork = (options: OwnedWebSocketNetworkOptions): OwnedWebSocketNetwork =>
    new OwnedWebSocketNetwork(options);

/** predicate that decides whether a raw inbound string belongs to this runtime */
export type RawOwnershipPredicate = (raw: string) => boolean;

/**
 * Wrap a `NetworkSupportable` so subscribers only see inbound raw strings accepted by `shouldHandleRaw`.
 *
 * Both chatic and proxy share this single boundary mechanism. The predicate only filters inbound
 * `onMessage`; outbound `send` and every other member delegate to the source unchanged.
 */
export const createFilteredNetwork = (
    source: NetworkSupportable,
    shouldHandleRaw: RawOwnershipPredicate,
): NetworkSupportable => new FilteredNetwork(source, shouldHandleRaw);

/** `NetworkSupportable` decorator that filters inbound raw strings by ownership predicate */
class FilteredNetwork implements NetworkSupportable {
    public constructor(
        private readonly source: NetworkSupportable,
        private readonly shouldHandleRaw: RawOwnershipPredicate,
    ) {}

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
        this.source.send(data);
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        return this.source.onMessage(raw => {
            if (!this.shouldHandleRaw(raw)) return;
            handler(raw);
        });
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
}

const createDefaultWebSocket = (options: OwnedWebSocketNetworkOptions): WebSocketClosable => {
    const WS = (globalThis as any).WebSocket;
    if (typeof WS !== 'function') {
        throw new Error(`global WebSocket is not available; provide options.socketFactory`);
    }
    return new WS(options.url, options.protocols);
};

const waitWebSocketOpen = (ws: WebSocketCompartible, timeoutMs: number): Promise<void> => {
    if (ws.readyState === stateValue(ws, 'OPEN', 1)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer =
            timeoutMs > 0
                ? setTimeout(
                      () => rejectOnce(new Error(`timeout waiting for WebSocket open: ${timeoutMs}ms`)),
                      timeoutMs,
                  )
                : undefined;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('close', onClose);
        };
        const resolveOnce = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const rejectOnce = (error: any) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onOpen = () => resolveOnce();
        const onError = (event: WebSocketCompartibleEventMap['error']) => rejectOnce(event);
        const onClose = () => rejectOnce(new Error(`WebSocket closed before open`));
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
        ws.addEventListener('close', onClose, { once: true });
    });
};

const stateValue = (
    ws: WebSocketCompartible,
    key: 'OPEN' | 'CLOSING' | 'CLOSED' | 'CONNECTING',
    fallback: number,
): number => (typeof ws[key] === 'number' ? ws[key] : fallback);

const asWebSocketText = async (data: unknown): Promise<string> => {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    const readable = data as { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof readable?.text === 'function') return readable.text();
    if (typeof readable?.arrayBuffer === 'function') return new TextDecoder().decode(await readable.arrayBuffer());
    return String(data);
};

const tryParseWebSocketJSON = (text: string) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};
