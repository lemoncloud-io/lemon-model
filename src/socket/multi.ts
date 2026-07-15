/**
 * `socket/multi.ts`
 * - `NetworkSupportable` composite that pairs N (>=2) networks — a main plus one or more backups.
 * - `send`/`onMessage`/etc follow the main (index 0); `sendAll` is the only multi-transport extension call.
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

/** `scope` values `MultiSocketNetwork` puts on `SocketErrorContext` */
export const MULTI_NETWORK_SCOPE = {
    send: 'network.multi.send',
} as const;

/** `SocketErrorContext` extended with the origin socket index (0 = main); `types.ts` stays untouched */
export interface MultiSocketErrorContext extends SocketErrorContext {
    /** which socket the error originated from; 0 is the main socket */
    index: number;
}

/** `NetworkSupportable` plus the multi-transport extension call */
export interface MultiNetworkSupportable extends NetworkSupportable {
    /** send the same raw string to every socket; never throws, failures surface via onError */
    sendAll(data: string): void;
}

/** per-index network factory for the `{ count, networkFactory }` convenience overload */
export interface MultiSocketNetworkFactory {
    (index: number): NetworkSupportable;
}

/**
 * `NetworkSupportable` composite over N (>=2) sockets.
 *
 * `send`/`readyState`/`ready`/`onOpen` delegate to the main socket (index 0) only (01 no-breakage).
 * `sendAll` is the only member that touches every socket; failures never throw and are only
 * observable via `onError`.
 */
class MultiSocketNetwork implements MultiNetworkSupportable {
    /** array (not Set) so a handler subscribed twice fires twice, matching the underlying delegation path */
    private readonly errorHandlers: SocketErrorHandler[] = [];

    public constructor(private readonly networks: NetworkSupportable[]) {}

    public get readyState(): SocketReadyState {
        return this.networks[0].readyState;
    }

    public ready(): Promise<void> {
        return this.networks[0].ready?.() ?? Promise.resolve();
    }

    public onOpen(handler: () => void): SocketUnsubscribe {
        return this.networks[0].onOpen?.(handler) ?? (() => undefined);
    }

    public send(data: string): void {
        this.networks[0].send(data);
    }

    /** send to every socket independently; each failure is caught and re-emitted with index, never thrown */
    public sendAll(data: string): void {
        this.networks.forEach((network, index) => this.trySend(network, data, index));
    }

    public onMessage(handler: NetworkMessageHandler): SocketUnsubscribe {
        const unsubscribes = this.networks.map(network => network.onMessage(handler));
        return () => unsubscribes.forEach(unsubscribe => unsubscribe());
    }

    public onError(handler: SocketErrorHandler): SocketUnsubscribe {
        const unsubscribes = this.networks.map((network, index) =>
            network.onError((error, context) => {
                const tagged: MultiSocketErrorContext = { ...context, network: this, index };
                handler(error, tagged);
            }),
        );
        this.errorHandlers.push(handler);
        return () => {
            unsubscribes.forEach(unsubscribe => unsubscribe());
            const index = this.errorHandlers.indexOf(handler);
            if (index >= 0) this.errorHandlers.splice(index, 1);
        };
    }

    public configure(options: SocketNetworkOptions): void {
        this.networks.forEach(network => network.configure?.(options));
    }

    /** close every socket independently (idempotent); onError subscriptions stay alive so post-close sendAll failures are still observable */
    public close(code?: number, reason?: string): void {
        this.networks.forEach(network => {
            try {
                network.close(code, reason);
            } catch {
                // ignore; the other sockets must still be closed
            }
        });
    }

    private trySend(network: NetworkSupportable, data: string, index: number): void {
        try {
            network.send(data);
        } catch (e) {
            const context: MultiSocketErrorContext = { scope: MULTI_NETWORK_SCOPE.send, network: this, index };
            for (const handler of [...this.errorHandlers]) {
                try {
                    handler(e, context);
                } catch {
                    // sendAll() must never throw; a throwing consumer handler cannot break the other sockets' send
                }
            }
        }
    }
}

/** create a `NetworkSupportable` composite over an array of networks (>=2) */
export function createMultiSocketNetwork(networks: NetworkSupportable[]): MultiNetworkSupportable;
/** create a `NetworkSupportable` composite by calling `networkFactory` `count` times (>=2) */
export function createMultiSocketNetwork(options: {
    count: number;
    networkFactory: MultiSocketNetworkFactory;
}): MultiNetworkSupportable;
export function createMultiSocketNetwork(
    input: NetworkSupportable[] | { count: number; networkFactory: MultiSocketNetworkFactory },
): MultiNetworkSupportable {
    const count = Array.isArray(input) ? input.length : input.count;
    if (count < 2) {
        throw new Error(`@networks (2+) is required - createMultiSocketNetwork(${count})`);
    }
    const networks = Array.isArray(input)
        ? input
        : Array.from({ length: count }, (_, index) => input.networkFactory(index));
    return new MultiSocketNetwork(networks);
}
