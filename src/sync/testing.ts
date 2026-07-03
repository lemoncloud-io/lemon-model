/**
 * `sync/testing.ts`
 * - bridges the in-memory `Peer` simulator into a single `NetworkSupportable` for L3/L4 specs.
 * - test/dev only; kept OUT of `sync/index.ts` so production bundles never pull in the simulator runtime.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
//! simulator runtime lives in the isolated `../socket/testing` module (kept out of the root barrel).
import { createNetwork, createPeer, PeerOptions } from '../socket/testing';
import { NetworkSupportable, PeerSupportable } from '../socket/types';

/** server-side pieces of a bridged peer link */
export interface PeerBridge {
    /** bridged client-side network. wire this into `createSocketClient()` */
    network: NetworkSupportable;
    /** plain server `Peer`. register `onMessage()`/`post()` on it as the simulated server band */
    server: PeerSupportable;
    /** raw downlink (server -> client). for JSONTransport/progress producers simulating server pushes that are not sync envelopes */
    serverNetwork: NetworkSupportable;
    /** assigned client id, usable with `server.post(message, { clientId })` */
    clientId: string;
}

export interface PeerBridgeOptions {
    server?: PeerOptions;
    client?: PeerOptions;
}

/**
 * create a connected client/server `Peer` pair and expose the client side as one `NetworkSupportable`.
 *
 * `Peer.dispatch` settles an envelope against its own pending map, and otherwise fans every remaining
 * envelope out to `Peer.onMessage()` listeners whose return value becomes an automatic `result` reply
 * (regardless of whether the listener actually returns anything). A client-side bridge built on
 * `clientPeer.post()` + `clientPeer.onMessage()` therefore echoes every pull result and every server
 * event straight back to the server as an empty `result`, and — since the server has no pending for
 * that mid either — the server echoes it right back, forever. `send()` and `onMessage()` below instead
 * talk to the raw uplink/downlink `Network` instances directly, bypassing `Peer` dispatch on the client
 * side entirely, so no such reply is ever produced. The `server` `Peer` itself is untouched and keeps
 * its normal `onMessage()`/`post()` contract for the simulated server band.
 */
export const createPeerBridge = (options?: PeerBridgeOptions): PeerBridge => {
    let serverNetwork: NetworkSupportable | undefined;
    const server: PeerSupportable = createPeer({
        ...options?.server,
        networkFactory: context =>
            (serverNetwork = createNetwork({
                id: context.id,
                fromPeerId: context.fromPeerId,
                toPeerId: context.toPeerId,
                logger: context.logger,
                ...context.options,
            })),
    });
    const client: PeerSupportable = createPeer(options?.client);
    const clientId = client.connect(server);
    const clientNetwork = client.network;
    if (!clientNetwork || !serverNetwork) {
        throw new Error(`@peer bridge network capture failed - sync.testing.createPeerBridge`);
    }

    const network: NetworkSupportable = {
        get readyState() {
            return client.readyState;
        },
        ready: () => client.ready(),
        send: (data: string) => clientNetwork!.send(data),
        onMessage: handler => serverNetwork!.onMessage(handler),
        onError: handler => client.onError(handler),
        close: () => client.close(),
    };

    return { network, server, serverNetwork, clientId };
};
