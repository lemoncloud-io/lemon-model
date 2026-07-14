/**
 * `socket/socket.ts`
 * - in-memory peer WebSocket simulator.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkMessageHandler,
    NetworkSupportable,
    PeerMessageContext,
    PeerMessageHandler,
    PeerSupportable,
    PeerTargetOptions,
    SocketErrorContext,
    SocketErrorHandler,
    SocketLogEntry,
    SocketLogger,
    SocketLogLevel,
    SocketNetworkOptions,
    SocketMessage,
    SocketReadyState,
    SocketUnsubscribe,
} from './types';
import {
    calculateJSONTransportChunkBytes,
    createJSONTransport,
    JSONTransportOptions,
    JSONTransportSupportable,
    ReliableOptions,
    splitJSON,
} from './transport';

/** options for simulated peers */
export interface PeerOptions extends SocketNetworkOptions {
    /** peer id */
    id?: string;
    /** id generator used by peers, peer links, and auto message ids */
    identityProvider?: PeerIdentityProvider;
    /** network factory used by peer connect/reconnect */
    networkFactory?: PeerNetworkFactory;
    /** structured logger for peer lifecycle and delivery events */
    logger?: SocketLogger;
    /**
     * enable JSON transport chunking for peer message envelopes sent by this peer.
     * for `jsonTransport.reliable`, both the sending and receiving peer must opt in — an
     * asymmetric setup surfaces as `json.reliable.mismatch` on the non-reliable side.
     * onError pattern: `error instanceof JSONTransportReliableError` gives access to `error.tid`.
     */
    jsonTransport?: boolean | JSONTransportOptions;
    /**
     * shortcut for `jsonTransport: { reliable: true }` — the recommended entry point for reliable
     * delivery, equivalent to setting `reliable` on `jsonTransport` directly. truthy activates JSON
     * transport chunking even when `jsonTransport` is otherwise unset. an explicit `jsonTransport.reliable`
     * takes precedence over this shortcut when both are set. both the sending and receiving peer must
     * opt in — an asymmetric setup surfaces as `json.reliable.mismatch` on the non-reliable side.
     */
    reliable?: boolean | ReliableOptions;
}

/** network creation context independent from peer instances. */
export interface PeerNetworkFactoryContext {
    /** generated network id */
    id: string;
    /** sending peer id */
    fromPeerId: string;
    /** receiving peer id */
    toPeerId: string;
    /** resolved network behavior options */
    options: Required<SocketNetworkOptions>;
    /** logger propagated from the creating peer */
    logger?: SocketLogger;
}

/** factory for creating peer link networks. */
export interface PeerNetworkFactory {
    (context: PeerNetworkFactoryContext): NetworkSupportable;
}

/** id generator for deterministic peer tests and custom runtimes. */
export interface PeerIdentityProvider {
    /** generate peer id */
    nextPeerId(): string;
    /** generate client id assigned by the accepting peer */
    nextClientId(): string;
    /** generate message id for peer.send() */
    nextMessageId(): string;
    /** generate network id; peer ids are provided for link networks */
    nextNetworkId(fromPeerId?: string, toPeerId?: string): string;
}

/** options for socket factory */
export interface SocketFactoryOptions extends PeerOptions {
    /** prefix used when auto-generating peer ids */
    idPrefix?: string;
}

interface PendingResult {
    resolve: (data: any) => void;
    reject: (error: any) => void;
}

interface PeerLink {
    peer: Peer<any, any>;
    clientId?: string;
    network: NetworkSupportable;
    transportOptions?: JSONTransportOptions;
    receiverTransport?: JSONTransportSupportable<any>;
    /** reliable-on links merge sender+receiver into one instance — points at the same object as receiverTransport */
    senderTransport?: JSONTransportSupportable<any>;
}

let peerNo = 0;
let clientNo = 0;
let messageNo = 0;
let networkNo = 0;

export const defaultPeerIdentityProvider: PeerIdentityProvider = {
    nextPeerId: () => `peer-${++peerNo}`,
    nextClientId: () => `client-${++clientNo}`,
    nextMessageId: () => `message-${++messageNo}`,
    nextNetworkId: (fromPeerId?: string, toPeerId?: string) =>
        fromPeerId && toPeerId ? `${fromPeerId}->${toPeerId}` : `network-${++networkNo}`,
};
export const nextMessageId = () => defaultPeerIdentityProvider.nextMessageId();
export const defaultPeerNetworkFactory: PeerNetworkFactory = context =>
    createNetwork({
        id: context.id,
        fromPeerId: context.fromPeerId,
        toPeerId: context.toPeerId,
        logger: context.logger,
        ...context.options,
    });
export const noopSocketLogger: SocketLogger = { log: () => undefined };
const delay = (ms: number) => (ms > 0 ? new Promise<void>(resolve => setTimeout(resolve, ms)) : undefined);
const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;
const DEFAULT_JITTER_MS = 1;

export interface NetworkOptions extends SocketNetworkOptions {
    id?: string;
    fromPeerId?: string;
    toPeerId?: string;
    logger?: SocketLogger;
}

/**
 * one-shot in-memory network transport.
 * - public transport surface is intentionally limited to send(string) and close().
 */
export class Network implements NetworkSupportable {
    public readonly id: string;
    private state: SocketReadyState = 'open';
    private readonly messageListeners = new Set<NetworkMessageHandler>();
    private used = false;
    private options: Required<SocketNetworkOptions>;
    private deliveryNo = 0;
    private readonly errorListeners = new Set<SocketErrorHandler>();
    private readonly fromPeerId?: string;
    private readonly toPeerId?: string;
    private readonly logger: SocketLogger;

    public constructor(options?: NetworkOptions) {
        this.id = options?.id ?? defaultPeerIdentityProvider.nextNetworkId();
        this.fromPeerId = options?.fromPeerId;
        this.toPeerId = options?.toPeerId;
        this.logger = options?.logger ?? noopSocketLogger;
        this.options = asNetworkOptions(options);
        this.log('debug', 'network created', 'network.constructor', { data: { options: this.options } });
    }

    /** network state */
    public get readyState(): SocketReadyState {
        return this.state;
    }

    /** wait until this in-memory network is ready */
    public async ready(): Promise<void> {
        this.ensureOpen('network.ready');
        this.log('debug', 'network ready', 'network.ready');
    }

    /** attach this network to exactly one receiver */
    public attach(receiver: NetworkMessageHandler): void {
        if (this.used) throw new Error(`@network[${this.id}] is already used - network.attach(${this.id})`);
        this.ensureOpen('network.attach');
        this.used = true;
        this.messageListeners.add(receiver);
        this.log('debug', 'network receiver attached', 'network.attach');
    }

    /** send raw string data over the network */
    public send(data: string): void {
        this.ensureOpen('network.send');
        if (this.messageListeners.size <= 0) {
            throw new Error(`@network[${this.id}] is not connected - network.send(${this.id})`);
        }
        if (typeof data !== 'string') throw new Error(`@data (string) is required - network.send(${this.id})`);
        const bytes = byteLength(data);
        if (bytes > this.options.maxPacketBytes) throw new Error(`1009: message too big`);

        const listeners = [...this.messageListeners];
        this.log('debug', 'network packet queued', 'network.send', {
            data: { bytes, listeners: listeners.length },
        });
        const _deliver = async () => {
            try {
                await delay(this.nextDeliveryDelayMs());
                if (this.state !== 'open') return;
                for (const listener of listeners) listener(data);
                this.log('debug', 'network packet delivered', 'network.deliver', {
                    data: { bytes, listeners: listeners.length },
                });
            } catch (e) {
                this.log('error', 'network delivery failed', 'network.deliver', { error: e });
                this.emitError(e, { scope: 'network.deliver', network: this });
            }
        };
        _deliver();
    }

    /** subscribe to raw string data delivered from the network */
    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        this.ensureOpen('network.onMessage');
        this.messageListeners.add(handler);
        this.log('debug', 'network message listener added', 'network.onMessage', {
            data: { listeners: this.messageListeners.size },
        });
        return () => {
            this.messageListeners.delete(handler);
            this.log('debug', 'network message listener removed', 'network.onMessage.unsubscribe', {
                data: { listeners: this.messageListeners.size },
            });
        };
    }

    /** update network conditions */
    public configure(options: SocketNetworkOptions): void {
        this.options = { ...this.options, ...options };
        this.log('info', 'network configured', 'network.configure', { data: { options: this.options } });
    }

    /** observe asynchronous network delivery errors */
    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorListeners.add(handler);
        return () => {
            this.errorListeners.delete(handler);
        };
    }

    /** close this network forever */
    public close(): void {
        if (this.state === 'closed') return;
        this.state = 'closed';
        this.messageListeners.clear();
        this.log('info', 'network closed', 'network.close');
    }

    private ensureOpen(scope: string): void {
        if (this.state !== 'open') throw new Error(`@network[${this.id}] connection error: ${this.state} - ${scope}`);
    }

    private nextDeliveryDelayMs(): number {
        const baseMs = this.options.latencyMs;
        if (!this.options.unordered) return baseMs;

        const jitterMs = this.deliveryNo++ % 2 === 0 ? this.options.jitterMs : 0;
        return baseMs + jitterMs;
    }

    private emitError(error: any, context: SocketErrorContext): void {
        for (const listener of [...this.errorListeners]) {
            listener(error, context);
        }
    }

    private log(
        level: SocketLogLevel,
        message: string,
        location: string,
        entry?: Partial<Omit<SocketLogEntry, 'time' | 'level' | 'message' | 'location' | 'networkId' | 'error'>> & {
            error?: any;
        },
    ): void {
        try {
            this.logger.log({
                time: Date.now(),
                level,
                message,
                location,
                networkId: this.id,
                peerId: this.fromPeerId,
                remotePeerId: this.toPeerId,
                ...entry,
                error: entry?.error == null ? undefined : normalizeError(entry.error),
            });
        } catch {
            // Logging must never break simulated network behavior.
        }
    }
}

/** create a one-shot network */
export const createNetwork = (options?: NetworkOptions) => new Network(options);

/**
 * in-memory peer that can act as a server, a client, or both.
 */
export class Peer<SendData = any, MessageData = any> implements PeerSupportable<SendData, MessageData> {
    public readonly id: string;
    private assignedClientId?: string;
    private state: SocketReadyState = 'open';
    private server?: PeerLink;
    private readonly clients = new Map<string, PeerLink>();
    private readonly listeners = new Set<PeerMessageHandler<MessageData, any>>();
    private readonly errorListeners = new Set<SocketErrorHandler>();
    private readonly pending = new Map<string, PendingResult>();
    private networkOptions: Required<SocketNetworkOptions>;
    private identityProvider: PeerIdentityProvider;
    private networkFactory: PeerNetworkFactory;
    private logger: SocketLogger;
    private jsonTransportOptions?: JSONTransportOptions;

    public constructor(options?: PeerOptions) {
        this.identityProvider = options?.identityProvider ?? defaultPeerIdentityProvider;
        this.networkFactory = options?.networkFactory ?? defaultPeerNetworkFactory;
        this.logger = options?.logger ?? noopSocketLogger;
        this.id = options?.id ?? this.identityProvider.nextPeerId();
        this.networkOptions = asNetworkOptions(options);
        this.jsonTransportOptions = asJSONTransportOptions(
            mergeReliableShortcut(options?.jsonTransport, options?.reliable, (top, nested) =>
                this.log('warn', 'jsonTransport.reliable overrides top-level reliable shortcut', 'peer.constructor', {
                    data: { reliable: top, jsonTransportReliable: nested },
                }),
            ),
            this.networkOptions.maxPacketBytes,
        );
        this.log('debug', 'peer created', 'peer.constructor');
    }

    /** assigned client id when this peer is connected to another peer */
    public get clientId(): string | undefined {
        return this.assignedClientId;
    }

    /** endpoint state */
    public get readyState(): SocketReadyState {
        return this.state;
    }

    /** upstream network when this peer is connected as a client */
    public get network(): NetworkSupportable | undefined {
        return this.server?.network;
    }

    /** wait until this peer's upstream network is ready */
    public async ready(): Promise<void> {
        this.ensureOpen('peer.ready');
        const network = this.server?.network;
        if (!network?.ready) {
            this.log('debug', 'peer ready without upstream network wait', 'peer.ready', {
                networkId: getNetworkId(network),
            });
            return;
        }

        this.log('debug', 'waiting for upstream network ready', 'peer.ready.wait', {
            networkId: getNetworkId(network),
        });
        try {
            await network.ready();
            this.log('debug', 'upstream network ready', 'peer.ready.ok', {
                networkId: getNetworkId(network),
            });
        } catch (e) {
            this.log('error', 'upstream network ready failed', 'peer.ready.error', {
                networkId: getNetworkId(network),
                error: e,
            });
            throw e;
        }
    }

    /** update network conditions for this peer and connected networks */
    public configureNetwork(options: SocketNetworkOptions): void {
        this.networkOptions = { ...this.networkOptions, ...options };
        this.server?.network.configure?.(this.networkOptions);
        for (const link of this.clients.values()) {
            link.network.configure?.(this.networkOptions);
        }
        this.log('info', 'network options configured', 'peer.configureNetwork', {
            data: { options: this.networkOptions },
        });
    }

    /** connect this peer as a client to a server peer */
    public connect(peer: PeerSupportable<MessageData, SendData>): string {
        this.ensureOpen('peer.connect');
        const server = peer as Peer<MessageData, SendData>;
        server.ensureOpen('peer.accept');
        this.log('info', 'connecting peer', 'peer.connect', { remotePeerId: server.id });

        const { uplink, downlink } = Peer.createNetworkPair(this, server, 'peer.connect');
        const serverTransportOptions = server.jsonTransportOptions;
        const clientTransportOptions = this.jsonTransportOptions;
        const clientId = server.accept(this, downlink, serverTransportOptions);

        /**
         * connect() wiring — docs/specs/reliable-chunk-transport/02-design.md "Peer 통합" 배선표 그대로:
         * | instance | readNetwork | writeNetwork | receiver | sender       | clientId  | localTransportOptions  | remoteTransportOptions |
         * |----------|-------------|--------------|----------|--------------|-----------|------------------------|-------------------------|
         * | server   | uplink      | downlink     | server   | this(client) | clientId  | serverTransportOptions | clientTransportOptions |
         * | client   | downlink    | uplink       | this     | server       | undefined | clientTransportOptions | serverTransportOptions |
         * flipping any column here reproduces an error-free hang, not a thrown error.
         */
        server.attachClientTransport(
            clientId,
            Peer.attachTransport(
                uplink,
                downlink,
                server,
                this,
                clientId,
                serverTransportOptions,
                clientTransportOptions,
            ),
        );
        const clientTransport = Peer.attachTransport(
            downlink,
            uplink,
            this,
            server,
            undefined,
            clientTransportOptions,
            serverTransportOptions,
        );

        this.server = {
            peer: server as unknown as Peer<any, any>,
            clientId,
            network: uplink,
            transportOptions: clientTransportOptions,
            receiverTransport: clientTransport,
            senderTransport: clientTransportOptions?.reliable ? clientTransport : undefined,
        };
        this.assignedClientId = clientId;
        this.log('info', 'peer connected', 'peer.connect', {
            remotePeerId: server.id,
            clientId,
            networkId: getNetworkId(uplink),
        });
        server.log('info', 'client accepted', 'peer.accept', {
            remotePeerId: this.id,
            clientId,
            networkId: getNetworkId(downlink),
        });
        return clientId;
    }

    /** replace connected network instances while keeping the peer relationship */
    public reconnect(options?: PeerTargetOptions): string {
        this.ensureOpen('peer.reconnect');

        if (options?.clientId) {
            const link = this.clients.get(options.clientId);
            if (!link) throw new Error(`@clientId[${options.clientId}] is not connected - peer.reconnect(${this.id})`);
            Peer.reconnectPair(link.peer, this, options.clientId);
            this.log('info', 'peer network reconnected', 'peer.reconnect', {
                remotePeerId: link.peer.id,
                clientId: options.clientId,
            });
            return options.clientId;
        }

        if (this.server?.clientId) {
            Peer.reconnectPair(this, this.server.peer, this.server.clientId);
            this.log('info', 'peer network reconnected', 'peer.reconnect', {
                remotePeerId: this.server.peer.id,
                clientId: this.server.clientId,
            });
            return this.server.clientId;
        }

        if (this.clients.size === 1) {
            const [clientId, link] = [...this.clients.entries()][0];
            Peer.reconnectPair(link.peer, this, clientId);
            this.log('info', 'peer network reconnected', 'peer.reconnect', {
                remotePeerId: link.peer.id,
                clientId,
            });
            return clientId;
        }

        if (this.clients.size > 1) throw new Error(`@clientId (string) is required - peer.reconnect(${this.id})`);
        throw new Error(`@peer is not connected - peer.reconnect(${this.id})`);
    }

    /** find a client peer connected to this peer by client id */
    public findPeer<T extends PeerSupportable<any, any> = PeerSupportable<any, any>>(clientId: string): T | undefined {
        return this.clients.get(clientId)?.peer as unknown as T | undefined;
    }

    /** post a typed message without waiting for a result */
    public post(message: SocketMessage<SendData>, options?: PeerTargetOptions): void {
        this.publish(message, options);
    }

    /** send a typed message and wait for a result message with the same mid */
    public async send<R = any>(
        message: Omit<SocketMessage<SendData>, 'mid'> & { mid?: string },
        options?: PeerTargetOptions,
    ): Promise<R> {
        const mid = message.mid ?? this.identityProvider.nextMessageId();
        const envelope = { ...message, mid } as SocketMessage<SendData>;

        return new Promise<R>((resolve, reject) => {
            this.pending.set(mid, { resolve, reject });
            try {
                this.publish(envelope, options);
            } catch (e) {
                this.pending.delete(mid);
                reject(e);
            }
        });
    }

    /** subscribe to incoming messages */
    public onMessage<T = MessageData, R = any>(handler: PeerMessageHandler<T, R>): SocketUnsubscribe {
        this.ensureOpen('peer.onMessage');
        const listener = handler as unknown as PeerMessageHandler<MessageData, any>;
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** observe fire-and-forget transport errors */
    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        this.errorListeners.add(handler);
        return () => {
            this.errorListeners.delete(handler);
        };
    }

    /** close this peer */
    public close(): void {
        if (this.state === 'closed') return;
        this.log('info', 'peer closing', 'peer.close');
        this.state = 'closed';
        const server = this.server;
        this.server = undefined;
        if (server) {
            this.closeLink(server);
            server.peer.detachClient(server.clientId);
        }
        for (const [clientId, link] of this.clients) {
            this.closeLink(link);
            if (link.peer.server?.peer === this) {
                link.peer.closeLink(link.peer.server);
                link.peer.server = undefined;
                link.peer.assignedClientId = undefined;
            }
            this.clients.delete(clientId);
        }
        this.clients.clear();
        this.listeners.clear();
        for (const [mid, pending] of this.pending) {
            pending.reject(new Error(`@peer[${this.id}] is closed - peer.close(${mid})`));
        }
        this.pending.clear();
        this.log('info', 'peer closed', 'peer.close');
    }

    private accept(
        client: Peer<any, any>,
        network: NetworkSupportable,
        transportOptions?: JSONTransportOptions,
    ): string {
        const clientId = this.identityProvider.nextClientId();
        this.clients.set(clientId, { peer: client, network, transportOptions });
        return clientId;
    }

    private attachClientTransport(clientId: string, transport?: JSONTransportSupportable<any>): void {
        const link = this.clients.get(clientId);
        if (!link) return;
        link.receiverTransport = transport;
        link.senderTransport = link.transportOptions?.reliable ? transport : undefined;
    }

    private detachClient(clientId?: string): void {
        if (!clientId) return;
        const link = this.clients.get(clientId);
        if (!link) return;
        this.log('info', 'client detached', 'peer.detachClient', {
            remotePeerId: link.peer.id,
            clientId,
            networkId: getNetworkId(link.network),
        });
        this.closeLink(link);
        this.clients.delete(clientId);
    }

    private closeLink(link: PeerLink): void {
        this.log('debug', 'closing peer link', 'peer.closeLink', {
            remotePeerId: link.peer.id,
            clientId: link.clientId,
            networkId: getNetworkId(link.network),
        });
        link.receiverTransport?.detach?.();
        link.receiverTransport = undefined;
        link.senderTransport?.detach?.(); //! idempotent — reliable links share receiverTransport's instance
        link.senderTransport = undefined;
        link.network.close();
    }

    private static reconnectPair(client: Peer<any, any>, server: Peer<any, any>, clientId: string): void {
        client.ensureOpen('peer.reconnect');
        server.ensureOpen('peer.reconnect');

        const clientLink = client.server;
        const serverLink = server.clients.get(clientId);
        if (!clientLink || clientLink.peer !== server || !serverLink || serverLink.peer !== client) {
            throw new Error(`@clientId[${clientId}] link mismatch - peer.reconnect(${server.id})`);
        }

        const { uplink, downlink } = Peer.createNetworkPair(client, server, 'peer.reconnect');

        client.closeLink(clientLink);
        server.closeLink(serverLink);

        const clientTransportOptions = client.jsonTransportOptions;
        const serverTransportOptions = server.jsonTransportOptions;

        clientLink.network = uplink;
        clientLink.transportOptions = clientTransportOptions;
        clientLink.receiverTransport = Peer.attachTransport(
            downlink,
            uplink,
            client,
            server,
            undefined,
            clientTransportOptions,
            serverTransportOptions,
        );
        clientLink.senderTransport = clientTransportOptions?.reliable ? clientLink.receiverTransport : undefined;

        serverLink.network = downlink;
        serverLink.transportOptions = serverTransportOptions;
        serverLink.receiverTransport = Peer.attachTransport(
            uplink,
            downlink,
            server,
            client,
            clientId,
            serverTransportOptions,
            clientTransportOptions,
        );
        serverLink.senderTransport = serverTransportOptions?.reliable ? serverLink.receiverTransport : undefined;

        client.assignedClientId = clientId;
        client.log('info', 'peer link networks replaced', 'peer.reconnectPair', {
            remotePeerId: server.id,
            clientId,
            networkId: getNetworkId(uplink),
        });
        server.log('info', 'peer link networks replaced', 'peer.reconnectPair', {
            remotePeerId: client.id,
            clientId,
            networkId: getNetworkId(downlink),
        });
    }

    /**
     * reliable-on locals merge write+read networks into one instance (Peer 통합 절):
     * writeNetwork carries send()+ack/nack/error, receiveNetwork(=readNetwork) carries the onMessage subscription.
     * off (remoteTransportOptions only, or neither) keeps the existing receiver-only/raw paths untouched.
     */
    private static attachTransport(
        readNetwork: NetworkSupportable,
        writeNetwork: NetworkSupportable,
        receiver: Peer<any, any>,
        sender: Peer<any, any>,
        clientId: string | undefined,
        localTransportOptions?: JSONTransportOptions,
        remoteTransportOptions?: JSONTransportOptions,
        logger?: SocketLogger,
    ): JSONTransportSupportable<any> | undefined {
        if (localTransportOptions?.reliable) {
            const reliable = localTransportOptions.reliable === true ? {} : localTransportOptions.reliable;
            const transport = createJSONTransport<SocketMessage<any>>(writeNetwork, {
                ...localTransportOptions,
                reliable: { ...reliable, receiveNetwork: readNetwork },
                logger: localTransportOptions.logger ?? logger ?? receiver.logger,
            });
            transport.onMessage(message =>
                receiver.dispatch(message, sender, clientId).catch(e => receiver.rejectPending(message?.mid, e)),
            );
            transport.onError((error, context) => {
                receiver.log('error', 'peer transport error', 'peer.transport', {
                    remotePeerId: sender.id,
                    clientId,
                    networkId: getNetworkId(writeNetwork),
                    error,
                    data: { scope: context.scope },
                });
                receiver.emitError(error, { ...context, scope: `peer.transport.${context.scope}`, peer: receiver });
            });
            return transport;
        }

        if (remoteTransportOptions) {
            const transport = createJSONTransport<SocketMessage<any>>(readNetwork, {
                ...remoteTransportOptions,
                logger: remoteTransportOptions.logger ?? receiver.logger,
            });
            transport.onMessage(message =>
                receiver.dispatch(message, sender, clientId).catch(e => receiver.rejectPending(message?.mid, e)),
            );
            transport.onError((error, context) => {
                receiver.log('error', 'peer transport error', 'peer.transport', {
                    remotePeerId: sender.id,
                    clientId,
                    networkId: getNetworkId(readNetwork),
                    error,
                    data: { scope: context.scope },
                });
                receiver.emitError(error, { ...context, scope: `peer.transport.${context.scope}`, peer: receiver });
            });
            return transport;
        }

        readNetwork.onMessage(data => receiver.receiveNetworkData(data, sender, clientId));
        return undefined;
    }

    private createPeerNetwork(toPeer: Peer<any, any>): NetworkSupportable {
        const context: PeerNetworkFactoryContext = {
            id: this.identityProvider.nextNetworkId(this.id, toPeer.id),
            fromPeerId: this.id,
            toPeerId: toPeer.id,
            options: { ...this.networkOptions },
            logger: this.logger,
        };
        let network: NetworkSupportable;
        try {
            network = this.networkFactory(context);
        } catch (e) {
            const { logger: _logger, ...logContext } = context;
            this.log('error', 'peer network creation failed', 'peer.createPeerNetwork', {
                remotePeerId: toPeer.id,
                networkId: context.id,
                error: e,
                data: { context: logContext },
            });
            throw e;
        }
        const { logger: _logger, ...logContext } = context;
        this.log('debug', 'peer network created', 'peer.createPeerNetwork', {
            remotePeerId: toPeer.id,
            networkId: getNetworkId(network) ?? context.id,
            data: { context: logContext },
        });
        return network;
    }

    private static createNetworkPair(
        client: Peer<any, any>,
        server: Peer<any, any>,
        location: string,
    ): { uplink: NetworkSupportable; downlink: NetworkSupportable } {
        let uplink: NetworkSupportable | undefined;
        try {
            uplink = client.createPeerNetwork(server);
            const downlink = server.createPeerNetwork(client);
            return { uplink, downlink };
        } catch (e) {
            uplink?.close();
            client.log('error', 'peer network pair creation failed', location, {
                remotePeerId: server.id,
                error: e,
            });
            server.log('error', 'peer network pair creation failed', location, {
                remotePeerId: client.id,
                error: e,
            });
            throw e;
        }
    }

    private publish(message: SocketMessage<SendData>, options?: PeerTargetOptions): void {
        this.ensureOpen('peer.post');
        if (!message?.type) throw new Error(`@message.type (string) is required - peer.post(${this.id})`);
        if (!message?.mid) throw new Error(`@message.mid (string) is required - peer.post(${this.id})`);

        const target = this.resolveTarget(options);
        this.log('debug', 'publishing peer message', 'peer.publish', {
            remotePeerId: target.peer.id,
            clientId: target.clientId,
            mid: message.mid,
            type: message.type,
            networkId: getNetworkId(target.network),
        });
        const _deliver = async () => {
            try {
                await this.sendToLink(target, message);
            } catch (e) {
                this.log('error', 'peer publish failed', 'peer.publish', {
                    remotePeerId: target.peer.id,
                    clientId: target.clientId,
                    mid: message.mid,
                    type: message.type,
                    networkId: getNetworkId(target.network),
                    error: e,
                });
                const pending = this.pending.get(message.mid);
                if (pending) {
                    this.pending.delete(message.mid);
                    pending.reject(e);
                } else {
                    this.emitError(e, {
                        scope: 'peer.post',
                        mid: message.mid,
                        peer: this,
                        network: target.network,
                        message,
                    });
                }
            }
        };

        _deliver();
    }

    private resolveTarget(options?: PeerTargetOptions): PeerLink {
        const clientId = options?.clientId;
        if (clientId) {
            const link = this.clients.get(clientId);
            if (!link) throw new Error(`@clientId[${clientId}] is not connected - peer.post(${this.id})`);
            return link;
        }

        if (this.server) return this.server;

        if (this.clients.size === 1) return [...this.clients.values()][0];
        if (this.clients.size > 1) throw new Error(`@clientId (string) is required - peer.post(${this.id})`);
        throw new Error(`@peer is not connected - peer.post(${this.id})`);
    }

    private receiveNetworkData(data: string, sender?: Peer<any, any>, clientId?: string): void {
        try {
            const message = JSON.parse(data) as SocketMessage<MessageData>;
            this.dispatch(message, sender, clientId).catch(e => {
                this.rejectPending(message?.mid, e);
            });
        } catch (e) {
            this.log('error', 'peer network data parse failed', 'peer.receiveNetworkData', {
                remotePeerId: sender?.id,
                clientId,
                error: e,
            });
            this.rejectPending(undefined, e);
        }
    }

    private async dispatch(
        message: SocketMessage<MessageData>,
        sender?: Peer<any, any>,
        clientId?: string,
    ): Promise<void> {
        this.ensureOpen('peer.dispatch');
        this.log('debug', 'dispatching peer message', 'peer.dispatch', {
            remotePeerId: sender?.id,
            clientId,
            mid: message?.mid,
            type: message?.type,
        });

        if (message.type === 'result' || message.type === 'pong') {
            const pending = this.pending.get(message.mid);
            if (pending) {
                this.pending.delete(message.mid);
                this.log('debug', 'pending peer message resolved', 'peer.dispatch.result', {
                    remotePeerId: sender?.id,
                    clientId,
                    mid: message.mid,
                    type: message.type,
                });
                pending.resolve(message.data);
                return;
            }
        }

        if (message.type === 'error') {
            const pending = this.pending.get(message.mid);
            if (pending) {
                this.pending.delete(message.mid);
                this.log('warn', 'pending peer message rejected', 'peer.dispatch.error', {
                    remotePeerId: sender?.id,
                    clientId,
                    mid: message.mid,
                    type: message.type,
                    data: { errorData: message.data },
                });
                pending.reject(message.data);
                return;
            }
        }

        if (message.type === 'ping') {
            this.log('debug', 'replying pong to ping', 'peer.dispatch.ping', {
                remotePeerId: sender?.id,
                clientId,
                mid: message.mid,
                type: message.type,
            });
            this.reply(sender, message.mid, 'pong', { clientId });
            return;
        }

        const context: PeerMessageContext = {
            mid: message.mid,
            type: message.type,
            peer: this,
            sender,
            clientId,
            receivedAt: Date.now(),
            reply: <R = any>(data: R) => this.reply(sender, message.mid, 'result', data),
        };
        const listeners = [...this.listeners];
        const results = [];

        for (const listener of listeners) {
            results.push(await listener(message, context));
        }

        if (results.length > 0) context.reply(results.length <= 1 ? results[0] : results);
    }

    private reply<R = any>(target: Peer<any, any> | undefined, mid: string, type: string, data: R): void {
        if (!target) return;
        const _deliver = async () => {
            try {
                const link = this.findLinkTo(target);
                if (link) {
                    this.log('debug', 'replying peer message', 'peer.reply', {
                        remotePeerId: target.id,
                        clientId: link.clientId,
                        mid,
                        type,
                        networkId: getNetworkId(link.network),
                    });
                    await this.sendToLink(link, { type, data, mid });
                }
            } catch (e) {
                this.log('error', 'peer reply failed', 'peer.reply', {
                    remotePeerId: target.id,
                    mid,
                    type,
                    error: e,
                });
                target.rejectPending(mid, e);
            }
        };
        _deliver();
    }

    private sendToLink<Data = any>(link: PeerLink, message: SocketMessage<Data>): void | Promise<void> {
        if (link.senderTransport) return link.senderTransport.send(message);
        if (link.transportOptions) {
            splitJSON(message, link.transportOptions).send(link.network);
        } else {
            link.network.send(JSON.stringify(message));
        }
    }

    private findLinkTo(target: Peer<any, any>): PeerLink | undefined {
        if (this.server?.peer === target) return this.server;
        for (const link of this.clients.values()) {
            if (link.peer === target) return link;
        }
        return undefined;
    }

    private rejectPending(mid: string | undefined, error: any): void {
        if (!mid) return;
        const pending = this.pending.get(mid);
        if (!pending) return;
        this.pending.delete(mid);
        pending.reject(error);
    }

    private emitError(error: any, context: SocketErrorContext): void {
        this.log('error', 'peer error emitted', 'peer.emitError', {
            mid: context.mid,
            type: context.message?.type,
            networkId: getNetworkId(context.network),
            error,
            data: { scope: context.scope },
        });
        for (const listener of [...this.errorListeners]) {
            listener(error, context);
        }
    }

    private ensureOpen(scope: string): void {
        if (this.state !== 'open') throw new Error(`@peer[${this.id}] is ${this.state} - ${scope}(${this.id})`);
    }

    private log(
        level: SocketLogLevel,
        message: string,
        location: string,
        entry?: Partial<Omit<SocketLogEntry, 'time' | 'level' | 'message' | 'location' | 'peerId' | 'error'>> & {
            error?: any;
        },
    ): void {
        try {
            this.logger.log({
                time: Date.now(),
                level,
                message,
                location,
                peerId: this.id,
                ...entry,
                error: entry?.error == null ? undefined : normalizeError(entry.error),
            });
        } catch {
            // Logging must never break simulated socket behavior.
        }
    }
}

/** create a peer */
export const createPeer = <SendData = any, MessageData = any>(options?: PeerOptions) =>
    new Peer<SendData, MessageData>(options);

/**
 * factory for creating peers and keeping a small registry for tests.
 */
export class SocketFactory {
    private no = 0;
    private readonly peers = new Map<string, Peer<any, any>>();

    public constructor(private readonly options?: SocketFactoryOptions) {}

    /** create and register a peer */
    public peer<SendData = any, MessageData = any>(options?: PeerOptions): Peer<SendData, MessageData> {
        const peer = createPeer<SendData, MessageData>({
            latencyMs: options?.latencyMs ?? this.options?.latencyMs,
            jitterMs: options?.jitterMs ?? this.options?.jitterMs,
            unordered: options?.unordered ?? this.options?.unordered,
            maxPacketBytes: options?.maxPacketBytes ?? this.options?.maxPacketBytes,
            identityProvider: options?.identityProvider ?? this.options?.identityProvider,
            networkFactory: options?.networkFactory ?? this.options?.networkFactory,
            logger: options?.logger ?? this.options?.logger,
            jsonTransport: options?.jsonTransport ?? this.options?.jsonTransport,
            reliable: options?.reliable ?? this.options?.reliable,
            id: options?.id ?? this.nextFactoryPeerId(options),
        });
        this.peers.set(peer.id, peer);
        return peer;
    }

    /** find a registered peer by peer id */
    public find<T extends PeerSupportable<any, any> = PeerSupportable<any, any>>(id: string): T | undefined {
        return this.peers.get(id) as unknown as T | undefined;
    }

    /** connect client to server and return the assigned client id */
    public connect(client: PeerSupportable<any, any>, server: PeerSupportable<any, any>): string {
        return client.connect(server);
    }

    /** find a client peer connected to a server peer by client id */
    public findPeer<T extends PeerSupportable<any, any> = PeerSupportable<any, any>>(
        server: PeerSupportable<any, any>,
        clientId: string,
    ): T | undefined {
        return server.findPeer<T>(clientId);
    }

    private nextFactoryPeerId(options?: PeerOptions): string | undefined {
        if ((options?.identityProvider || this.options?.identityProvider) && !this.options?.idPrefix) return undefined;
        return `${this.options?.idPrefix ?? 'peer'}-${++this.no}`;
    }
}

/** create a socket factory */
export const createSocketFactory = (options?: SocketFactoryOptions) => new SocketFactory(options);

const asNetworkOptions = (options?: SocketNetworkOptions): Required<SocketNetworkOptions> => ({
    latencyMs: options?.latencyMs ?? 0,
    jitterMs: options?.jitterMs ?? DEFAULT_JITTER_MS,
    unordered: options?.unordered ?? true,
    maxPacketBytes: options?.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES,
});

/**
 * merges the `PeerOptions.reliable` shortcut into `jsonTransport` before resolution.
 * off (`reliable` falsy) returns `jsonTransport` untouched — the shortcut path is inert unless used.
 * an explicit `jsonTransport.reliable` wins over the shortcut when both are set; `onMismatch` fires
 * when both are set to different values, so the caller can warn without duplicating this check.
 */
const mergeReliableShortcut = (
    jsonTransport?: boolean | JSONTransportOptions,
    reliable?: boolean | ReliableOptions,
    onMismatch?: (top: boolean | ReliableOptions, nested: boolean | ReliableOptions) => void,
): boolean | JSONTransportOptions | undefined => {
    if (!reliable) return jsonTransport;
    const transportOptions: JSONTransportOptions = jsonTransport && jsonTransport !== true ? jsonTransport : {};
    if (transportOptions.reliable !== undefined && transportOptions.reliable !== reliable) {
        onMismatch?.(reliable, transportOptions.reliable);
    }
    return { ...transportOptions, reliable: transportOptions.reliable ?? reliable };
};

const asJSONTransportOptions = (
    options?: boolean | JSONTransportOptions,
    peerMaxPacketBytes?: number,
): JSONTransportOptions | undefined => {
    if (!options) return undefined;
    const transportOptions = options === true ? {} : options;
    if (transportOptions.chunkBytes || !peerMaxPacketBytes) return transportOptions;
    return {
        ...transportOptions,
        chunkBytes: calculateJSONTransportChunkBytes(peerMaxPacketBytes, transportOptions.envelopeReserveBytes),
    };
};

const getNetworkId = (network?: NetworkSupportable): string | undefined => {
    const id = (network as any)?.id;
    return typeof id === 'string' ? id : undefined;
};

const normalizeError = (error: any): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};

const byteLength = (value: string): number => new TextEncoder().encode(value).length;
