/**
 * `websocket.spec.ts`
 * - tests for the real-WebSocket → `NetworkSupportable` bridge and connection-id handshake.
 * - the bridge is extracted into the shared socket core (was `proxy/transport.ts` upstream),
 *   so its spec is owned here rather than ported from eureka-agents-api.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import {
    BrowserWebSocketNetwork,
    extractWebSocketConnectionId,
    waitWebSocketConnectionId,
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
