/**
 * `websocket.spec.ts`
 * - tests for the real-WebSocket → `NetworkSupportable` bridge and connection-id handshake.
 * - the bridge is extracted into the shared socket core (was `proxy/transport.ts` upstream),
 *   so its spec is owned here rather than ported from the source project.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import {
    NetworkMessageHandler,
    NetworkSupportable,
    SocketErrorHandler,
    SocketNetworkOptions,
    SocketReadyState,
    SocketUnsubscribe,
} from './types';
import {
    BrowserWebSocketNetwork,
    createFilteredNetwork,
    createOwnedWebSocketNetwork,
    extractWebSocketConnectionId,
    waitWebSocketConnectionId,
    WebSocketClosable,
    WebSocketCompartible,
    WebSocketCompartibleEventMap,
} from './websocket';

/** fake browser WebSocket implementing the `WebSocketCompartible` contract. */
class FakeWebSocket implements WebSocketCompartible {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = 1;
    public readonly sent: string[] = [];
    private readonly listeners: { [K in keyof WebSocketCompartibleEventMap]?: Set<(event: any) => void> } = {};

    public send(data: string): void {
        this.sent.push(data);
    }
    public addEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
    ): void {
        (this.listeners[type] ??= new Set()).add(handler as any);
    }
    public removeEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
    ): void {
        this.listeners[type]?.delete(handler as any);
    }
    public emit<K extends keyof WebSocketCompartibleEventMap>(type: K, event: WebSocketCompartibleEventMap[K]): void {
        for (const handler of [...(this.listeners[type] ?? [])]) handler(event);
    }
}

/** fake owned WebSocket starting in CONNECTING and tracking actual close() calls. */
class FakeOwnedWebSocket extends FakeWebSocket implements WebSocketClosable {
    public readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

    public constructor(initialReadyState = 0) {
        super();
        this.readyState = initialReadyState;
    }
    public open(): void {
        this.readyState = this.OPEN;
        this.emit('open', undefined);
    }
    public close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        this.readyState = this.CLOSED;
        this.emit('close', undefined);
    }
}

/** controllable in-memory NetworkSupportable source for decorator tests. */
class MockNetwork implements NetworkSupportable {
    public readyState: SocketReadyState = 'open';
    public readonly sent: string[] = [];
    public closed = false;
    public readyCalls = 0;
    public readonly configured: SocketNetworkOptions[] = [];
    private readonly messageHandlers = new Set<NetworkMessageHandler>();
    private readonly errorHandlers = new Set<SocketErrorHandler>();

    public ready(): Promise<void> {
        this.readyCalls += 1;
        return Promise.resolve();
    }
    public send(data: string): void {
        this.sent.push(data);
    }
    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }
    public configure(options: SocketNetworkOptions): void {
        this.configured.push(options);
    }
    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }
    public close(): void {
        this.closed = true;
    }
    public emit(raw: string): void {
        for (const handler of [...this.messageHandlers]) handler(raw);
    }
    public emitError(error: any): void {
        for (const handler of [...this.errorHandlers]) handler(error, { scope: 'mock', network: this });
    }
    public get messageHandlerCount(): number {
        return this.messageHandlers.size;
    }
}

describe('extractWebSocketConnectionId', () => {
    it('should read connection id from known handshake shapes', async () => {
        expect2(() => extractWebSocketConnectionId({ connectionId: 'c1' })).toEqual('c1');
        expect2(() => extractWebSocketConnectionId({ connId: 'c2' })).toEqual('c2');
        expect2(() => extractWebSocketConnectionId({ data: { connectionId: 'c3' } })).toEqual('c3');
        expect2(() => extractWebSocketConnectionId({ data: { connId: { id: 'c4' } } })).toEqual('c4');
        expect2(() => extractWebSocketConnectionId({ body: { id: 'c5' } })).toEqual('c5');
        expect2(() => extractWebSocketConnectionId({ id: 'c6' })).toEqual('c6');
        expect2(() => extractWebSocketConnectionId({ nope: true })).toEqual(undefined);
        expect2(() => extractWebSocketConnectionId(null)).toEqual(undefined);
    });
});

describe('BrowserWebSocketNetwork', () => {
    it('should bridge a WebSocketCompartible to NetworkSupportable', async () => {
        const ws = new FakeWebSocket();
        const network = new BrowserWebSocketNetwork(ws);

        expect2(() => network.readyState).toEqual('open');
        await network.ready();

        const messages: string[] = [];
        network.onMessage(data => messages.push(data));

        ws.emit('message', { data: 'hello-from-server' });
        ws.emit('message', { data: 'second' });
        // non-string frames are ignored
        ws.emit('message', { data: 123 as any });
        expect2(() => messages).toEqual(['hello-from-server', 'second']);

        network.send('ping');
        expect2(() => ws.sent).toEqual(['ping']);

        // close() detaches listeners but does NOT close the externally-owned socket
        network.close();
        expect2(() => network.readyState).toEqual('closed');
    });

    it('should throw on send/onMessage after detach', async () => {
        const ws = new FakeWebSocket();
        const network = new BrowserWebSocketNetwork(ws);
        network.detach();

        expect2(() => network.send('x')).toEqual('@network connection error: closed - browserWebSocket.send');
        expect2(() => network.onMessage(() => undefined)).toEqual(
            '@network connection error: closed - browserWebSocket.onMessage',
        );
    });
});

describe('waitWebSocketConnectionId', () => {
    it('should send the handshake and resolve the first connection id', async () => {
        const ws = new FakeWebSocket();
        const pending = waitWebSocketConnectionId(ws, { connectMessage: 'device.save', timeoutMs: 1000 });

        // the handshake is sent only AFTER the (already-open) socket's open await resolves — yield a tick.
        await new Promise(resolve => setTimeout(resolve, 5));
        expect2(() => ws.sent).toEqual(['device.save']);

        ws.emit('message', { data: JSON.stringify({ data: { connectionId: 'conn-xyz' } }) });
        expect2(await pending).toEqual('conn-xyz');
    });
});

describe('OwnedWebSocketNetwork', () => {
    it('should create the socket via factory and wait for open in ready()', async () => {
        const ws = new FakeOwnedWebSocket();
        const network = createOwnedWebSocketNetwork({
            url: 'wss://x',
            protocols: 'p1',
            socketFactory: () => ws,
        });

        expect2(() => network.readyState).toEqual('connecting');
        let resolved = false;
        const pending = network.ready().then(() => (resolved = true));
        let openedSync = false;
        network.onOpen(() => (openedSync = true));
        await new Promise(resolve => setTimeout(resolve, 5));
        expect2(() => resolved).toEqual(false);

        ws.open();
        expect2(() => openedSync).toEqual(true); // onOpen fires synchronously on the open event
        await pending;
        expect2(() => resolved).toEqual(true);
        expect2(() => network.readyState).toEqual('open');
    });

    it('should pass url/protocols to the socket factory', async () => {
        let context: any;
        const ws = new FakeOwnedWebSocket(1);
        createOwnedWebSocketNetwork({
            url: 'wss://host/path',
            protocols: ['a', 'b'],
            socketFactory: ctx => {
                context = ctx;
                return ws;
            },
        });
        expect2(() => context).toEqual({ url: 'wss://host/path', protocols: ['a', 'b'] });
    });

    it('should actual-close the socket on connect timeout', async () => {
        const ws = new FakeOwnedWebSocket();
        const network = createOwnedWebSocketNetwork({
            url: 'wss://x',
            socketFactory: () => ws,
            connectTimeoutMs: 20,
        });

        let error: any;
        await network.ready().catch(e => (error = e));
        expect2(() => String(error?.message)).toEqual('timeout waiting for WebSocket open: 20ms');
        expect2(() => ws.closeCalls.length).toEqual(1);
        expect2(() => network.readyState).toEqual('closed');
    });

    it('should only send raw string when OPEN', async () => {
        const ws = new FakeOwnedWebSocket();
        const network = createOwnedWebSocketNetwork({ url: 'wss://x', socketFactory: () => ws });

        expect2(() => network.send('early')).toEqual('@network connection error: connecting - ownedWebSocket.send');
        ws.open();
        network.send('ping');
        expect2(() => ws.sent).toEqual(['ping']);
    });

    it('should deliver raw string messages and ignore non-string frames', async () => {
        const ws = new FakeOwnedWebSocket(1);
        const network = createOwnedWebSocketNetwork({ url: 'wss://x', socketFactory: () => ws });

        const messages: string[] = [];
        network.onMessage(data => messages.push(data));
        ws.emit('message', { data: 'one' });
        ws.emit('message', { data: 123 as any });
        ws.emit('message', { data: 'two' });
        expect2(() => messages).toEqual(['one', 'two']);
    });

    it('should forward socket error and close events to onError', async () => {
        const ws = new FakeOwnedWebSocket(1);
        const network = createOwnedWebSocketNetwork({ url: 'wss://x', socketFactory: () => ws });

        const scopes: string[] = [];
        network.onError((_error, context) => scopes.push(context.scope));
        ws.emit('error', undefined);
        ws.emit('close', undefined);
        expect2(() => scopes).toEqual(['ownedWebSocket', 'ownedWebSocket.close']);
    });

    it('should actual-close the owned socket on close()', async () => {
        const ws = new FakeOwnedWebSocket(1);
        const network = createOwnedWebSocketNetwork({ url: 'wss://x', socketFactory: () => ws });

        network.close(1012, 'service-restart');
        expect2(() => ws.closeCalls.length).toEqual(1);
        expect2(() => ws.closeCalls[0]).toEqual({ code: 1012, reason: 'service-restart' });
        expect2(() => network.readyState).toEqual('closed');
    });

    it('should fire onOpen immediately when subscribing to an already-open socket', () => {
        const ws = new FakeOwnedWebSocket(1);
        const network = createOwnedWebSocketNetwork({ url: 'wss://x', socketFactory: () => ws });

        let calls = 0;
        network.onOpen(() => (calls += 1));
        expect2(() => calls).toEqual(1); // latched: a late subscriber on an already-open socket is still notified once
    });
});

describe('createFilteredNetwork', () => {
    it('should pass only raw messages accepted by the predicate, unchanged', async () => {
        const source = new MockNetwork();
        const filtered = createFilteredNetwork(source, raw => raw.startsWith('mine:'));

        const received: string[] = [];
        filtered.onMessage(raw => received.push(raw));
        source.emit('mine:1');
        source.emit('other:2');
        source.emit('mine:3');
        expect2(() => received).toEqual(['mine:1', 'mine:3']);
    });

    it('should release the source subscription on unsubscribe', async () => {
        const source = new MockNetwork();
        const filtered = createFilteredNetwork(source, () => true);

        const unsubscribe = filtered.onMessage(() => undefined);
        expect2(() => source.messageHandlerCount).toEqual(1);
        unsubscribe();
        expect2(() => source.messageHandlerCount).toEqual(0);
    });

    it('should delegate send/close/onError/readyState to the source', async () => {
        const source = new MockNetwork();
        const filtered = createFilteredNetwork(source, raw => raw.startsWith('mine:'));

        // predicate does NOT apply to outbound send
        filtered.send('other:nope');
        expect2(() => source.sent).toEqual(['other:nope']);

        const errors: string[] = [];
        filtered.onError((_e, ctx) => errors.push(ctx.scope));
        source.emitError(new Error('boom'));
        expect2(() => errors).toEqual(['mock']);

        source.readyState = 'closing';
        expect2(() => filtered.readyState).toEqual('closing');

        filtered.close();
        expect2(() => source.closed).toEqual(true);
    });

    it('should delegate ready/configure when the source provides them', async () => {
        const source = new MockNetwork();
        const filtered = createFilteredNetwork(source, () => true);

        await filtered.ready?.();
        expect2(() => source.readyCalls).toEqual(1);

        filtered.configure?.({ latencyMs: 5 });
        expect2(() => source.configured).toEqual([{ latencyMs: 5 }]);
    });

    it('should fall back to resolve/no-op when the source lacks ready/configure', async () => {
        const bareSource: NetworkSupportable = {
            readyState: 'open',
            send: () => undefined,
            onMessage: () => () => undefined,
            onError: () => () => undefined,
            close: () => undefined,
        };
        const filtered = createFilteredNetwork(bareSource, () => true);

        expect2(await filtered.ready?.()).toEqual(undefined);
        expect2(() => filtered.configure?.({ latencyMs: 1 })).toEqual(undefined);
    });
});
