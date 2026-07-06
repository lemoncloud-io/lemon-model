/**
 * `progress/testing.ts`
 * - isolated entry for the progress end-to-end loop harness.
 * - kept OUT of the package root barrel so production bundles do not include the in-memory socket simulator.
 *
 * Usage (tests / dev only):
 *   import { runProgressLoop } from 'lemon-model/progress/testing';
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { createNetwork } from '../socket/socket';
import { SocketNetworkOptions } from '../socket/types';
import {
    createProgressConsumer,
    createProgressReporter,
    ProgressConsumerOptions,
    ProgressReporterOptions,
    ProgressState,
    ProgressTaskSupportable,
} from './progress';

export interface ProgressLoopOptions {
    /** update patch sequence to replay (start -> patches -> done/error). patch.id selects the task (default 'task') */
    script: Array<Partial<ProgressState>>;
    reporterOptions?: ProgressReporterOptions;
    consumerOptions?: ProgressConsumerOptions;
    /** in-memory network conditions (unordered, jitterMs, maxPacketBytes, ...) */
    networkOptions?: SocketNetworkOptions & { id?: string };
    /** wait time for async packet delivery */
    settleMs?: number;
}

export interface ProgressLoopMetrics {
    elapsedMs: number;
    /** raw packet count / total bytes / largest packet bytes (throttle / packet-limit checks) */
    packets: number;
    packetBytes: number;
    maxPacketBytes: number;
    /** snapshots emitted by the reporter (throttle suppression check) */
    emitted: number;
    /** applied by the consumer / dropped by seq judgement */
    applied: number;
    staleDropped: number;
    /** final consumer states at loop end */
    finalStates: ProgressState[];
}

/**
 * Run an end-to-end loop: script -> ProgressReporter -> NetworkSupportable -> ProgressConsumer,
 * and return numeric metrics for assertion (same pattern as `buffer/testing.runGenAIStreamNetworkLoop`).
 */
export const runProgressLoop = async (options: ProgressLoopOptions): Promise<ProgressLoopMetrics> => {
    const startedAt = Date.now();
    const network = createNetwork({ ...options.networkOptions });
    const typePrefix = options.consumerOptions?.typePrefix ?? 'progress:';
    const rawPackets: string[] = [];
    const unsubscribeRaw = network.onMessage(raw => rawPackets.push(raw));
    const consumer = createProgressConsumer(network, options.consumerOptions);
    let applied = 0;
    const unsubscribeChange = consumer.onChange(() => (applied += 1));
    let emitted = 0;
    const reporter = createProgressReporter(message => {
        emitted += 1;
        network.send(JSON.stringify(message));
    }, options.reporterOptions);

    try {
        const tasks = new Map<string, ProgressTaskSupportable>();
        const taskOf = (id: string): ProgressTaskSupportable => {
            const existing = tasks.get(id);
            if (existing) return existing;
            const started = reporter.start(id);
            tasks.set(id, started);
            return started;
        };
        for (const patch of options.script) {
            const { id, ts: _ts, seq: _seq, status, error, ...rest } = patch;
            const task = taskOf(id ?? 'task');
            if (status === 'done') task.done(rest);
            else if (status === 'error') task.error(error ?? 'error', rest);
            else task.update({ ...rest, error, status });
        }
        reporter.close();
        await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 50));

        const arrived = rawPackets.filter(raw => raw.includes(`"type":"${typePrefix}`)).length;
        return {
            elapsedMs: Date.now() - startedAt,
            packets: rawPackets.length,
            packetBytes: rawPackets.reduce((sum, raw) => sum + byteLength(raw), 0),
            maxPacketBytes: rawPackets.reduce((max, raw) => Math.max(max, byteLength(raw)), 0),
            emitted,
            applied,
            staleDropped: arrived - applied,
            finalStates: consumer.list(),
        };
    } finally {
        unsubscribeRaw();
        unsubscribeChange();
        consumer.close();
        network.close();
    }
};

const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;
