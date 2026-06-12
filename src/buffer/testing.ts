/**
 * `buffer/testing.ts`
 * - isolated entry for GenAI stream buffer diagnostic helpers.
 * - kept OUT of the package root barrel so production bundles do not include the in-memory socket simulator.
 *
 * Usage (tests / dev only):
 *   import { runGenAIStreamNetworkLoop } from 'lemon-model/buffer/testing';
 *
 * @origin eureka-agents-api / src/lib/buffer/network.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { createNetwork } from '../socket/socket';
import { NetworkSupportable, SocketNetworkOptions } from '../socket/types';
import { GenAIStreamBuffer, GenAIStreamBufferOptions, GenAIStreamBufferSnapshot, GenAIStreamEvent } from './stream';
import {
    createGenAIStreamNetworkConsumer,
    createGenAIStreamNetworkReceiver,
    GenAIStreamNetworkOptions,
} from './network';

export interface GenAIStreamNetworkLoopOptions {
    /** diagnostic network id when a network is created internally */
    id?: string;
    /** token payloads written into GenAIStreamBuffer */
    tokens: string[];
    /** GenAIStreamBuffer options for the loop */
    bufferOptions?: GenAIStreamBufferOptions;
    /** externally managed network; when omitted the helper creates one */
    network?: NetworkSupportable;
    /** in-memory network options when network is created internally */
    networkOptions?: SocketNetworkOptions & { id?: string };
    /** stream network adapter options used by both sender and receiver */
    streamNetwork?: GenAIStreamNetworkOptions;
    /** wait time after buffer.close() for async packet delivery */
    settleMs?: number;
}

export interface GenAIStreamNetworkLoopMetrics {
    /** total loop duration including settleMs */
    elapsedMs: number;
    /** raw network packet count */
    packets: number;
    /** sum of raw network packet bytes */
    packetBytes: number;
    /** largest raw network packet byte size */
    maxPacketBytes: number;
    /** number of JSONTransport chunk packets */
    chunkPackets: number;
    /** number of rebuilt GenAI stream events */
    events: number;
}

export interface GenAIStreamNetworkLoopResult {
    /** rebuilt events observed by the receiver consumer */
    events: GenAIStreamEvent[];
    /** raw string packets observed on NetworkSupportable */
    rawPackets: string[];
    /** final source buffer snapshot */
    snapshot: GenAIStreamBufferSnapshot;
    /** transport and loop metrics for diagnostics/performance checks */
    metrics: GenAIStreamNetworkLoopMetrics;
    /** network used by this run; caller-owned when options.network is supplied */
    network: NetworkSupportable;
}

/**
 * Run an end-to-end diagnostic loop:
 * tokens -> GenAIStreamBuffer -> JSONTransport -> NetworkSupportable ->
 * JSONTransport -> GenAIStreamConsumer.
 *
 * This helper is intended for tests, smoke checks, and lightweight performance
 * probes in environments that can provide a NetworkSupportable.
 */
export const runGenAIStreamNetworkLoop = async (
    options: GenAIStreamNetworkLoopOptions,
): Promise<GenAIStreamNetworkLoopResult> => {
    const startedAt = Date.now();
    const network =
        options.network ??
        createNetwork({
            id: options.networkOptions?.id ?? options.id,
            ...options.networkOptions,
        });
    const streamNetwork: GenAIStreamNetworkOptions = {
        ...(options.streamNetwork ?? {}),
        maxPacketBytes: options.streamNetwork?.maxPacketBytes ?? options.networkOptions?.maxPacketBytes,
    };
    const events: GenAIStreamEvent[] = [];
    const rawPackets: string[] = [];
    const unsubscribeRaw = network.onMessage(packet => rawPackets.push(packet));
    const receiver = createGenAIStreamNetworkReceiver(
        network,
        event => {
            events.push(event);
        },
        streamNetwork,
    );
    const sender = createGenAIStreamNetworkConsumer(network, streamNetwork);
    const buffer = new GenAIStreamBuffer(sender.consumer, options.bufferOptions);

    try {
        await buffer.start();
        for (const token of options.tokens) await buffer.write(token);
        await buffer.close();
        await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 50));

        const snapshot = buffer.snapshot();
        const packetBytes = rawPackets.reduce((sum, packet) => sum + byteLength(packet), 0);
        const maxPacketBytes = rawPackets.reduce((max, packet) => Math.max(max, byteLength(packet)), 0);
        const chunkPackets = rawPackets.filter(packet => {
            try {
                return JSON.parse(packet)?.type === 'json:chunk';
            } catch {
                return false;
            }
        }).length;

        return {
            events,
            rawPackets,
            snapshot,
            network,
            metrics: {
                elapsedMs: Date.now() - startedAt,
                packets: rawPackets.length,
                packetBytes,
                maxPacketBytes,
                chunkPackets,
                events: events.length,
            },
        };
    } finally {
        unsubscribeRaw();
        sender.detach();
        receiver.detach();
        if (!options.network) network.close();
    }
};

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;
