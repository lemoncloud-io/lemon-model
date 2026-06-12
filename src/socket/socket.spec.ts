/**
 * `socket.spec.ts`
 * - peer socket simulator test.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, GETERR } from '../cores/index.spec';
//! simulator runtime lives in the isolated `./socket` module (kept out of the root barrel).
import {
    createNetwork,
    createPeer,
    createSocketFactory,
    nextMessageId,
    Peer,
    PeerNetworkFactoryContext,
} from './socket';
import { NetworkSupportable, PeerSupportable, SocketLogEntry, SocketMessage } from './types';

const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
const peerIdentityProvider = () => {
    let peer = 0;
    let client = 0;
    let message = 0;
    let network = 0;
    return {
        nextPeerId: () => `p-${++peer}`,
        nextClientId: () => `c-${++client}`,
        nextMessageId: () => `m-${++message}`,
        nextNetworkId: (from?: string, to?: string) => (from && to ? `n-${from}-${to}-${++network}` : `n-${++network}`),
    };
};

describe('socket', () => {
    it('should support one-shot network send and close', async () => {
        const received: string[] = [];
        const network = createNetwork({ id: 'net-1' });
        const supportable: NetworkSupportable = network;

        supportable.onMessage(data => {
            received.push(data);
        });

        supportable.send('hello');
        await wait();
        expect2(() => received).toEqual(['hello']);
        supportable.configure?.({ maxPacketBytes: 3 });
        expect2(() => supportable.send('wide')).toEqual('1009: message too big');
        supportable.configure?.({ maxPacketBytes: 8 });
        supportable.send('again');
        await wait();
        expect2(() => received).toEqual(['hello', 'again']);

        supportable.close();
        expect2(() => supportable.readyState).toEqual('closed');
        expect2(() => supportable.send('closed')).toEqual('@network[net-1] connection error: closed - network.send');
    });

    it('should keep attach as a one-shot network receiver helper', async () => {
        const network = createNetwork({ id: 'net-attach' });
        const received: string[] = [];

        network.attach(data => {
            received.push(data);
        });

        network.send('hello');
        await wait();

        expect2(() => received).toEqual(['hello']);
        expect2(() => network.attach(() => undefined)).toEqual(
            '@network[net-attach] is already used - network.attach(net-attach)',
        );
    });

    it('should observe asynchronous network delivery errors', async () => {
        const network = createNetwork({ id: 'net-error' });
        const errors: string[] = [];
        const scopes: string[] = [];

        network.onMessage(() => {
            throw new Error('receiver failed');
        });
        network.onError((error, context) => {
            errors.push(GETERR(error));
            scopes.push(context.scope);
        });

        network.send('hello');
        await wait();

        expect2(() => errors).toEqual(['receiver failed']);
        expect2(() => scopes).toEqual(['network.deliver']);
    });

    it('should expose ready on network and peer for delayed network initialization', async () => {
        const events: string[] = [];
        const server = createPeer({ id: 'server' });
        const client = createPeer({
            id: 'client',
            networkFactory: context => {
                const network = createNetwork({ id: context.id, ...context.options });
                const supportable: NetworkSupportable = {
                    get readyState() {
                        return network.readyState;
                    },
                    ready: async () => {
                        events.push(`ready:${context.fromPeerId}->${context.toPeerId}`);
                        await wait(10);
                    },
                    send: data => network.send(data),
                    onMessage: handler => network.onMessage(handler),
                    configure: options => network.configure(options),
                    onError: handler => network.onError(handler),
                    close: () => network.close(),
                };
                return supportable;
            },
        });

        client.connect(server);
        await client.ready();

        expect2(() => events).toEqual(['ready:client->server']);
        await createNetwork({ id: 'net-ready' }).ready();
    });

    it('should pass typed send response by result mid', async () => {
        type Request = { a: number; b: number };
        type Response = { ok: true; value: number };

        const server = createPeer<Response, Request>({ id: 'server' });
        const client = createPeer<Request, Response>({ id: 'client' });
        client.connect(server);

        expect2(() => client.network?.readyState).toEqual('open');
        server.onMessage<Request, Response>(message => ({ ok: true, value: message.data.a + message.data.b }));

        const response = await client.send<Response>({ type: 'sum', data: { a: 2, b: 3 } });
        expect2(() => response).toEqual({ ok: true, value: 5 });
    });

    it('should use injected peer identity provider for peer, client, message, and network ids', async () => {
        const identityProvider = peerIdentityProvider();
        const server = createPeer({ identityProvider });
        const client = createPeer({ identityProvider });
        const mids: string[] = [];

        const clientId = client.connect(server);
        server.onMessage(message => {
            mids.push(message.mid);
            return { ok: true };
        });

        expect2(() => server.id).toEqual('p-1');
        expect2(() => client.id).toEqual('p-2');
        expect2(() => clientId).toEqual('c-1');
        expect2(() => (client.network as any)?.id).toEqual('n-p-2-p-1-1');
        expect2(await client.send({ type: 'hello', data: null })).toEqual({ ok: true });
        expect2(() => mids).toEqual(['m-1']);
    });

    it('should emit structured peer logs for important lifecycle and message events', async () => {
        const logs: SocketLogEntry[] = [];
        const logger = { log: (entry: SocketLogEntry) => logs.push(entry) };
        const server = createPeer({ id: 'server', logger });
        const client = createPeer({ id: 'client', logger });

        server.onMessage(message => ({ echo: message.data }));
        const clientId = client.connect(server);
        expect2(await client.send({ type: 'echo', data: 'hello' })).toEqual({ echo: 'hello' });
        client.network?.close();
        client.reconnect();
        client.close();

        expect2(() => logs.every(log => !!log.time && !!log.level && !!log.message && !!log.location)).toEqual(true);
        expect2(() => logs.some(log => log.location === 'peer.connect' && log.peerId === 'client')).toEqual(true);
        expect2(() => logs.some(log => log.location === 'peer.accept' && log.clientId === clientId)).toEqual(true);
        expect2(() => logs.some(log => log.location === 'network.send' && log.networkId)).toEqual(true);
        expect2(() => logs.some(log => log.location === 'network.deliver' && log.networkId)).toEqual(true);
        expect2(() => logs.some(log => log.location === 'peer.publish' && log.mid && log.type === 'echo')).toEqual(
            true,
        );
        expect2(() => logs.some(log => log.location === 'peer.dispatch.result' && log.level === 'debug')).toEqual(true);
        expect2(() => logs.some(log => log.location === 'peer.reconnectPair' && log.clientId === clientId)).toEqual(
            true,
        );
        expect2(() => logs.some(log => log.location === 'peer.close' && log.peerId === 'client')).toEqual(true);
    });

    it('should throw when peer network factory fails during connect or reconnect', async () => {
        const logs: SocketLogEntry[] = [];
        const logger = { log: (entry: SocketLogEntry) => logs.push(entry) };
        const failingFactory = () => {
            throw new Error('network factory failed');
        };
        const server = createPeer({ id: 'server', logger });
        const broken = createPeer({ id: 'broken', logger, networkFactory: failingFactory });

        expect2(() => broken.connect(server)).toEqual('network factory failed');
        expect2(() => logs.some(log => log.location === 'peer.createPeerNetwork' && log.level === 'error')).toEqual(
            true,
        );

        let calls = 0;
        const flakyFactory = (context: PeerNetworkFactoryContext) => {
            calls++;
            if (calls > 2) throw new Error('network reconnect failed');
            return createNetwork({ id: context.id, logger, ...context.options });
        };
        const goodServer = createPeer({ id: 'good-server', logger, networkFactory: flakyFactory });
        const client = createPeer({ id: 'client', logger, networkFactory: flakyFactory });
        client.connect(goodServer);
        goodServer.onMessage(message => ({ ok: message.data }));

        expect2(() => client.reconnect()).toEqual('network reconnect failed');
        expect2(await client.send({ type: 'ok', data: true })).toEqual({ ok: true });
        expect2(() => logs.some(log => log.location === 'peer.reconnect' && log.level === 'error')).toEqual(true);
    });

    it('should fail peer sends when the connected network is closed', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({ id: 'client' });
        client.connect(server);
        server.onMessage(() => ({ ok: true }));
        const closedNetwork = client.network;
        const clientId = client.clientId;

        client.network?.close();

        expect2(await client.send({ type: 'x', data: null }).catch(GETERR)).toEqual(
            '@network[client->server] connection error: closed - network.send',
        );
        expect2(() => client.reconnect()).toEqual(clientId);
        expect2(() => client.network?.readyState).toEqual('open');
        expect2(() => client.network !== closedNetwork).toEqual(true);
        expect2(await client.send({ type: 'x', data: null })).toEqual({ ok: true });
    });

    it('should reject send when serialized packet is too big', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({ id: 'client', maxPacketBytes: 48 });
        client.connect(server);

        server.onMessage(message => ({ ok: true, text: message.data?.text }));

        expect2(
            await client
                .send({ type: 'large', data: { text: 'this payload is intentionally too large' } })
                .catch(GETERR),
        ).toEqual('1009: message too big');

        client.configureNetwork({ maxPacketBytes: 1024 });
        expect2(await client.send({ type: 'large', data: { text: 'now ok' } })).toEqual({
            ok: true,
            text: 'now ok',
        });
    });

    it('should send a large peer message through JSON transport when enabled', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({
            id: 'client',
            maxPacketBytes: 256,
            jsonTransport: { largeValueBytes: 24, chunkBytes: 32 },
        });
        client.connect(server);

        server.onMessage(message => ({ ok: true, length: message.data.text.length }));

        const text = Array.from({ length: 24 }, (_, index) => `part-${index}|`).join('');
        expect2(await client.send({ type: 'large', data: { text } })).toEqual({
            ok: true,
            length: text.length,
        });
    });

    it('should derive peer JSON transport chunk size from maxPacketBytes when enabled with true', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({
            id: 'client',
            maxPacketBytes: 320,
            jsonTransport: true,
        });
        client.connect(server);
        const text = Array.from({ length: 24 }, (_, index) => `part-${index}|`).join('');

        server.onMessage(message => ({ length: message.data.text.length }));

        expect2(await client.send({ type: 'large', data: { text } })).toEqual({ length: text.length });
    });

    it('should observe post transport errors without a pending send', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({ id: 'client', maxPacketBytes: 48 });
        client.connect(server);
        const errors: string[] = [];
        const contexts: any[] = [];

        client.onError((error, context) => {
            errors.push(GETERR(error));
            contexts.push({
                scope: context.scope,
                mid: context.mid,
                type: context.message?.type,
            });
        });

        const mid = nextMessageId();
        client.post({ type: 'large', data: { text: 'this payload is intentionally too large' }, mid });
        await wait();

        expect2(() => errors).toEqual(['1009: message too big']);
        expect2(() => contexts).toEqual([{ scope: 'peer.post', mid, type: 'large' }]);
    });

    it('should reject send when serialized result packet is too big', async () => {
        const server = createPeer({ id: 'server', maxPacketBytes: 56 });
        const client = createPeer({ id: 'client' });
        client.connect(server);

        server.onMessage(() => ({ text: 'this result payload is intentionally too large' }));

        expect2(await client.send({ type: 'small', data: null }).catch(GETERR)).toEqual('1009: message too big');

        server.configureNetwork({ maxPacketBytes: 1024 });
        expect2(await client.send({ type: 'small', data: null })).toEqual({
            text: 'this result payload is intentionally too large',
        });
    });

    it('should send a large peer result through JSON transport when enabled', async () => {
        const server = createPeer({
            id: 'server',
            maxPacketBytes: 256,
            jsonTransport: { largeValueBytes: 24, chunkBytes: 32 },
        });
        const client = createPeer({ id: 'client' });
        client.connect(server);
        const text = Array.from({ length: 24 }, (_, index) => `result-${index}|`).join('');

        server.onMessage(() => ({ text }));

        expect2(await client.send({ type: 'small', data: null })).toEqual({ text });
    });

    it('should close JSON transport peer links cleanly', async () => {
        const server = createPeer({
            id: 'server',
            jsonTransport: { largeValueBytes: 16, chunkBytes: 24 },
        });
        const client = createPeer({
            id: 'client',
            jsonTransport: { largeValueBytes: 16, chunkBytes: 24 },
        });
        client.connect(server);

        client.close();

        expect2(() => client.readyState).toEqual('closed');
        expect2(() => server.findPeer(client.clientId ?? '')).toEqual(undefined);
        expect2(await client.send({ type: 'x', data: null }).catch(GETERR)).toEqual(
            '@peer[client] is closed - peer.post(client)',
        );
    });

    it('should reconnect peer networks with JSON transport enabled', async () => {
        const server = createPeer({
            id: 'server',
            maxPacketBytes: 256,
            jsonTransport: { largeValueBytes: 24, chunkBytes: 32 },
        });
        const client = createPeer({
            id: 'client',
            maxPacketBytes: 256,
            jsonTransport: { largeValueBytes: 24, chunkBytes: 32 },
        });
        const clientId = client.connect(server);
        const text = Array.from({ length: 24 }, (_, index) => `reconnect-${index}|`).join('');

        server.onMessage(message => ({ length: message.data.text.length }));
        client.network?.close();

        expect2(await client.send({ type: 'large', data: { text } }).catch(GETERR)).toEqual(
            '@network[client->server] connection error: closed - network.send',
        );
        expect2(() => server.reconnect({ clientId })).toEqual(clientId);
        expect2(await client.send({ type: 'large', data: { text } })).toEqual({ length: text.length });
    });

    it('should use an injected peer-independent network factory for connect and reconnect', async () => {
        const contexts: PeerNetworkFactoryContext[] = [];
        const networkFactory = (context: PeerNetworkFactoryContext) => {
            contexts.push(context);
            return createNetwork({ id: `custom-${context.id}`, ...context.options });
        };
        const server = createPeer({ id: 'server', networkFactory, unordered: false });
        const client = createPeer({ id: 'client', networkFactory, unordered: false });

        server.onMessage(message => ({ echo: message.data }));
        const clientId = client.connect(server);

        expect2(() => contexts.map(context => [context.fromPeerId, context.toPeerId])).toEqual([
            ['client', 'server'],
            ['server', 'client'],
        ]);
        expect2(() => (client.network as any)?.id).toEqual('custom-client->server');
        expect2(await client.send({ type: 'echo', data: 'first' })).toEqual({ echo: 'first' });

        client.network?.close();
        server.reconnect({ clientId });

        expect2(() => contexts.map(context => [context.fromPeerId, context.toPeerId])).toEqual([
            ['client', 'server'],
            ['server', 'client'],
            ['client', 'server'],
            ['server', 'client'],
        ]);
        expect2(await client.send({ type: 'echo', data: 'second' })).toEqual({ echo: 'second' });
    });

    it('should pass typed onMessage with unified message shape', async () => {
        type Event = { content: string };
        type Ack = { received: true };

        const server = createPeer<Ack, Event>();
        const client = createPeer<Event, Ack>();
        client.connect(server);
        const messages: SocketMessage<Event>[] = [];

        const unsubscribe = server.onMessage<Event, Ack>(message => {
            messages.push(message);
            return { received: true };
        });

        const mid = nextMessageId();
        const ack = await client.send<Ack>({ type: 'chunk', data: { content: 'hello' }, mid });
        expect2(() => ack).toEqual({ received: true });
        expect2(() => messages).toEqual([{ type: 'chunk', data: { content: 'hello' }, mid }]);

        unsubscribe();
        client.post({ type: 'chunk', data: { content: 'ignored' }, mid: nextMessageId() });
        await wait();
        expect2(() => messages.length).toEqual(1);
    });

    it('should pass post without waiting for result and create independent mids', async () => {
        type Event = { content: string };

        const server = createPeer<Event, Event>();
        const client = createPeer<Event, Event>();
        client.connect(server);
        const mids: string[] = [];
        const contents: string[] = [];

        server.onMessage<Event>(message => {
            mids.push(message.mid);
            contents.push(message.data.content);
        });

        client.post({ type: 'notice', data: { content: 'first' }, mid: nextMessageId() });
        client.post({ type: 'notice', data: { content: 'second' }, mid: nextMessageId() });
        await wait();

        expect2(() => [...contents].sort()).toEqual(['first', 'second']);
        expect2(() => mids.length).toEqual(2);
        expect2(() => mids[0] !== mids[1]).toEqual(true);
    });

    it('should not guarantee delivery order for back-to-back posts', async () => {
        type Event = { no: number };

        const server = createPeer<Event, Event>();
        const client = createPeer<Event, Event>();
        client.connect(server);
        const received: number[] = [];

        server.onMessage<Event>(message => {
            received.push(message.data.no);
        });

        client.post({ type: 'notice', data: { no: 1 }, mid: nextMessageId() });
        client.post({ type: 'notice', data: { no: 2 }, mid: nextMessageId() });
        await wait();

        expect2(() => received).toEqual([2, 1]);
    });

    it('should dynamically configure ordering behavior', async () => {
        type Event = { no: number };

        const server = createPeer<Event, Event>();
        const client = createPeer<Event, Event>();
        client.connect(server);
        const received: number[] = [];

        server.onMessage<Event>(message => {
            received.push(message.data.no);
        });

        client.configureNetwork({ unordered: false, jitterMs: 0 });
        client.post({ type: 'notice', data: { no: 1 }, mid: nextMessageId() });
        client.post({ type: 'notice', data: { no: 2 }, mid: nextMessageId() });
        await wait();

        expect2(() => received).toEqual([1, 2]);

        received.length = 0;
        client.configureNetwork({ unordered: true, jitterMs: 2 });
        client.post({ type: 'notice', data: { no: 3 }, mid: nextMessageId() });
        client.post({ type: 'notice', data: { no: 4 }, mid: nextMessageId() });
        await wait();

        expect2(() => received).toEqual([4, 3]);
    });

    it('should respond pong with assigned client id for ping', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({ id: 'client' });
        const clientId = client.connect(server);
        const receivedByServer: SocketMessage[] = [];

        server.onMessage(message => {
            receivedByServer.push(message);
        });

        const pong = await client.send<{ clientId: string }>({ type: 'ping', data: null });
        expect2(() => client.clientId).toEqual(clientId);
        expect2(() => pong).toEqual({ clientId });
        expect2(() => receivedByServer).toEqual([]);
    });

    it('should post pong with the same mid and client id for ping', async () => {
        const server = createPeer({ id: 'server' });
        const client = createPeer({ id: 'client' });
        const clientId = client.connect(server);
        const mid = nextMessageId();
        const pongMessages: SocketMessage<{ clientId: string }>[] = [];

        client.onMessage<{ clientId: string }>(message => {
            pongMessages.push(message);
        });

        client.post({ type: 'ping', data: null, mid });
        await wait();

        expect2(() => pongMessages).toEqual([{ type: 'pong', data: { clientId }, mid }]);
    });

    it('should support one upstream peer and multiple clients', async () => {
        type Event = { text: string };

        const upstream = createPeer<Event, Event>({ id: 'upstream' });
        const hub = createPeer<Event, Event>({ id: 'hub' });
        const clientA = createPeer<Event, Event>({ id: 'client-a' });
        const clientB = createPeer<Event, Event>({ id: 'client-b' });

        hub.connect(upstream);
        const clientAId = clientA.connect(hub);
        const clientBId = clientB.connect(hub);
        const received: string[] = [];

        upstream.onMessage<Event>(message => {
            received.push(`upstream:${message.data.text}`);
        });
        clientB.onMessage<Event>(message => {
            received.push(`clientB:${message.data.text}`);
        });

        hub.post({ type: 'notice', data: { text: 'to-upstream' }, mid: nextMessageId() });
        hub.post({ type: 'notice', data: { text: 'to-client-b' }, mid: nextMessageId() }, { clientId: clientBId });
        await wait();

        expect2(() => clientAId !== clientBId).toEqual(true);
        expect2(() => [...received].sort()).toEqual(['clientB:to-client-b', 'upstream:to-upstream']);
    });

    it('should expose peer supportable contract', async () => {
        const peer: PeerSupportable<SocketMessage, SocketMessage> = new Peer({ id: 'solo' });

        expect2(() => peer.readyState).toEqual('open');
        expect2(await peer.send({ type: 'x', data: null }).catch(GETERR)).toEqual(
            '@peer is not connected - peer.post(solo)',
        );
    });

    it('should create peers with SocketFactory and find connected peer by client id', async () => {
        type Event = { text: string };
        const factory = createSocketFactory({ idPrefix: 'sock' });
        const server = factory.peer<Event, Event>();
        const clientA = factory.peer<Event, Event>({ id: 'client-a' });
        const clientB = factory.peer<Event, Event>({ id: 'client-b' });

        const clientAId = factory.connect(clientA, server);
        const clientBId = factory.connect(clientB, server);

        expect2(() => server.id).toEqual('sock-1');
        expect2(() => factory.find(server.id)).toEqual(server);
        expect2(() => server.findPeer(clientAId)).toEqual(clientA);
        expect2(() => factory.findPeer(server, clientBId)).toEqual(clientB);
        expect2(() => factory.findPeer(server, 'missing')).toEqual(undefined);
        expect2(() => clientAId !== clientBId).toEqual(true);
    });

    it('should let SocketFactory inherit a peer identity provider', async () => {
        const factory = createSocketFactory({ identityProvider: peerIdentityProvider() });
        const server = factory.peer();
        const client = factory.peer();
        const clientId = factory.connect(client, server);

        expect2(() => server.id).toEqual('p-1');
        expect2(() => client.id).toEqual('p-2');
        expect2(() => clientId).toEqual('c-1');
        expect2(() => factory.find('p-1')).toEqual(server);
    });
});
