/**
 * `socket/types.ts`
 * - peer socket contracts for in-memory WebSocket simulation.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */

/** socket state for simulated peer endpoints */
export type SocketReadyState = 'connecting' | 'open' | 'closing' | 'closed';

/** unsubscribe function returned by event registration */
export type SocketUnsubscribe = () => void;

/** socket log severity. */
export type SocketLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** structured socket log entry. */
export interface SocketLogEntry {
    /** epoch timestamp in milliseconds */
    time: number;
    /** log severity */
    level: SocketLogLevel;
    /** human-readable message */
    message: string;
    /** stable source location */
    location: string;
    /** peer that emitted the log */
    peerId?: string;
    /** related peer id */
    remotePeerId?: string;
    /** related client id */
    clientId?: string;
    /** related message id */
    mid?: string;
    /** related message type */
    type?: string;
    /** related network id when available */
    networkId?: string;
    /** normalized error message when available */
    error?: string;
    /** extra structured metadata */
    data?: Record<string, any>;
}

/** logger interface used by peer/socket diagnostics. */
export interface SocketLogger {
    log(entry: SocketLogEntry): void;
}

/** callback used by network onMessage(). */
export interface NetworkMessageHandler {
    (data: string): void;
}

/**
 * minimal network transport contract.
 * - only string writes are supported.
 */
export interface NetworkSupportable {
    /** network state */
    readonly readyState: SocketReadyState;
    /** resolve when ready for send/onMessage; immediately if already open, reject if closed */
    ready?(): Promise<void>;
    /** subscribe to the open transition; fires once, immediately if already open. decorators must delegate */
    onOpen?(handler: () => void): SocketUnsubscribe;
    /** send raw string data over the network */
    send(data: string): void;
    /** subscribe to raw string data delivered from the network */
    onMessage(handler: NetworkMessageHandler): SocketUnsubscribe;
    /** optionally update network conditions */
    configure?(options: SocketNetworkOptions): void;
    /** observe asynchronous network delivery errors */
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    /** close the network permanently (code/reason forwarded when the network owns the socket) */
    close(code?: number, reason?: string): void;
}

/**
 * configurable network conditions for simulated sockets.
 */
export interface SocketNetworkOptions {
    /** base artificial delivery latency */
    latencyMs?: number;
    /** additional delivery jitter used to avoid strict time/order guarantees */
    jitterMs?: number;
    /** allow back-to-back messages to be delivered out of order */
    unordered?: boolean;
    /** maximum raw packet size in bytes */
    maxPacketBytes?: number;
}

/**
 * context provided to network/peer error handlers.
 */
export interface SocketErrorContext {
    /** error scope */
    scope: string;
    /** related message id if available */
    mid?: string;
    /** related peer if available */
    peer?: PeerSupportable<any, any>;
    /** related network if available */
    network?: NetworkSupportable;
    /** related socket message if available */
    message?: SocketMessage<any>;
}

/** callback used by onError(). */
export interface SocketErrorHandler {
    (error: any, context: SocketErrorContext): void;
}

/** socket message type */
export type SocketMessageType = 'message' | 'result' | 'error' | 'ping' | 'pong' | string;

/**
 * unified wire-level message for every peer.
 */
export interface SocketMessage<Data = any> {
    /** message type */
    type: SocketMessageType;
    /** message payload */
    data: Data;
    /** message id */
    mid: string;
}

/** target options for peer delivery */
export interface PeerTargetOptions {
    /** target client id when sending from a server peer to one of its clients */
    clientId?: string;
}

/**
 * context provided to an onMessage handler.
 */
export interface PeerMessageContext {
    /** message id */
    mid: string;
    /** message type */
    type: SocketMessageType;
    /** endpoint that received the message */
    peer: PeerSupportable<any, any>;
    /** endpoint that sent the message */
    sender?: PeerSupportable<any, any>;
    /** sender's client id when it is connected as a client to this peer */
    clientId?: string;
    /** epoch timestamp in milliseconds */
    receivedAt: number;
    /** send a result for the current message id */
    reply<R = any>(data: R): void;
}

/**
 * callback used by onMessage().
 */
export interface PeerMessageHandler<Data = any, Result = any> {
    (message: SocketMessage<Data>, context: PeerMessageContext): Result | Promise<Result>;
}

/**
 * minimal peer contract used by tests and mock flows.
 */
export interface PeerSupportable<SendData = any, MessageData = any> {
    /** peer id */
    readonly id: string;
    /** assigned client id when this peer is connected to another peer */
    readonly clientId?: string;
    /** endpoint state */
    readonly readyState: SocketReadyState;
    /** upstream network when this peer is connected as a client */
    readonly network?: NetworkSupportable;

    /** update network conditions for this peer and connected networks */
    configureNetwork(options: SocketNetworkOptions): void;

    /** wait until this peer's upstream network is ready */
    ready(): Promise<void>;

    /** observe fire-and-forget transport errors */
    onError(handler: SocketErrorHandler): SocketUnsubscribe;

    /** connect this peer as a client to a server peer */
    connect(peer: PeerSupportable<MessageData, SendData>): string;

    /** replace connected network instances while keeping the peer relationship */
    reconnect(options?: PeerTargetOptions): string;

    /** find a client peer connected to this peer by client id */
    findPeer<T extends PeerSupportable<any, any> = PeerSupportable<any, any>>(clientId: string): T | undefined;

    /** post a typed message without waiting for a result */
    post(message: SocketMessage<SendData>, options?: PeerTargetOptions): void;

    /** send a typed message and wait for a result message with the same mid */
    send<R = any>(
        message: Omit<SocketMessage<SendData>, 'mid'> & { mid?: string },
        options?: PeerTargetOptions,
    ): Promise<R>;

    /** subscribe to messages delivered to this peer */
    onMessage<T = MessageData, R = any>(handler: PeerMessageHandler<T, R>): SocketUnsubscribe;

    /** close this peer and its connected networks */
    close(): void;
}
