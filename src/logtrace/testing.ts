/**
 * `logtrace/testing.ts`
 * - isolated entry for the logtrace verification loop harness.
 * - kept OUT of the package root barrel so production bundles do not include the in-memory socket simulator.
 *
 * Usage (tests / dev only):
 *   import { runLogTraceLoop } from 'lemon-model/logtrace/testing';
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { createNetwork } from '../socket/socket';
import { SocketNetworkOptions } from '../socket/types';
import {
    createLogTraceConsumer,
    createLogTraceReporter,
    LogTraceConsumerOptions,
    LogTraceEntry,
    LogTraceLevel,
    LogTraceReporterOptions,
} from './logtrace';

export interface LogTraceLoopOptions {
    /** log sequence to replay */
    entries: Array<{ level: LogTraceLevel; message: string; json?: Record<string, any> }>;
    reporterOptions?: LogTraceReporterOptions;
    consumerOptions?: LogTraceConsumerOptions;
    /** in-memory network conditions (unordered, jitterMs, maxPacketBytes, ...) */
    networkOptions?: SocketNetworkOptions & { id?: string };
    /** wait time for async delivery */
    settleMs?: number;
}

export interface LogTraceLoopMetrics {
    elapsedMs: number;
    /** raw packet count / total bytes / largest packet bytes (batching efficiency + packet limit checks) */
    packets: number;
    packetBytes: number;
    maxPacketBytes: number;
    /** emitted batch count (flush 3-axis checks) */
    batches: number;
    /** entries reaching the consumer / truncated entries / observed seq gaps */
    delivered: number;
    truncated: number;
    gapCount: number;
    /** consumer retention at the end ((ts, seq) sorted) */
    finalEntries: LogTraceEntry[];
}

/**
 * Run an end-to-end verification loop:
 * entries -> LogTraceReporter (batching) -> NetworkSupportable -> LogTraceConsumer (ring buffer).
 *
 * Metrics-based assertions belong in specs; this helper only records numbers.
 */
export const runLogTraceLoop = async (options: LogTraceLoopOptions): Promise<LogTraceLoopMetrics> => {
    const startedAt = Date.now();
    const network = createNetwork(options.networkOptions);
    const rawPackets: string[] = [];
    const unsubscribeRaw = network.onMessage(packet => rawPackets.push(packet));
    const consumer = createLogTraceConsumer(network, options.consumerOptions);
    let delivered = 0;
    let truncated = 0;
    const unsubscribeEntry = consumer.onEntry(entry => {
        delivered += 1;
        if (entry.truncated) truncated += 1;
    });
    let batches = 0;
    const reporter = createLogTraceReporter(message => {
        batches += 1;
        network.send(JSON.stringify(message));
    }, options.reporterOptions);

    try {
        for (const record of options.entries) reporter.log(record.level, record.message, record.json);
        reporter.close();
        await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 50));

        const packetBytes = rawPackets.reduce((sum, packet) => sum + byteLength(packet), 0);
        const maxPacketBytes = rawPackets.reduce((max, packet) => Math.max(max, byteLength(packet)), 0);
        return {
            elapsedMs: Date.now() - startedAt,
            packets: rawPackets.length,
            packetBytes,
            maxPacketBytes,
            batches,
            delivered,
            truncated,
            gapCount: consumer.gapCount,
            finalEntries: consumer.list(),
        };
    } finally {
        unsubscribeRaw();
        unsubscribeEntry();
        consumer.close();
        network.close();
    }
};

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;
