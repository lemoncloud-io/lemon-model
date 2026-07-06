/**
 * `progress/progress.spec.ts`
 * - progress reporter/consumer tests over the shared socket contract (SPEC.md scenarios 1~8).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import { createNetwork } from '../socket/socket';
import { createJSONTransport } from '../socket/transport';
import { SocketMessage } from '../socket/types';
import {
    createBufferProgressGauge,
    createProgressConsumer,
    createProgressReporter,
    createTimeProgressGauge,
    ProgressState,
} from './progress';
import { runProgressLoop } from './testing';

const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

/** capture sink for reporter-only tests (no network) */
const captureSink = () => {
    const messages: SocketMessage<ProgressState>[] = [];
    const sink = (message: SocketMessage<ProgressState>) => {
        messages.push(message);
    };
    return { messages, sink };
};

describe('progress', () => {
    /* scenario 1: e2e - start -> update x N -> done converges on the client */
    it('converges start -> updates -> done to the final client state', async () => {
        const metrics = await runProgressLoop({
            script: [
                { status: 'running', step: 1, totalSteps: 3, percent: 10, label: 'github' },
                { step: 2, percent: 60, label: 'build' },
                { status: 'done', label: 'deploy' },
            ],
            // the in-memory network defaults to unordered+jitter; scenario 1 asserts exact counts
            networkOptions: { unordered: false, jitterMs: 0 },
        });
        expect2(() => metrics.emitted).toEqual(4); // start + 2 updates + done
        expect2(() => metrics.applied).toEqual(4);
        expect2(() => metrics.staleDropped).toEqual(0);
        expect2(() => metrics.finalStates.length).toEqual(1);
        const { ts: _ts, ...final } = metrics.finalStates[0];
        expect2(() => final).toEqual({
            id: 'task',
            status: 'done',
            step: 2,
            totalSteps: 3,
            percent: 60,
            label: 'deploy',
            seq: 4,
        });
    });

    /* scenario 2: unordered arrival still converges via seq judgement */
    it('converges under unordered delivery and never notifies stale snapshots', async () => {
        const script: Partial<ProgressState>[] = [];
        for (let i = 1; i <= 20; i++) script.push({ status: 'running', percent: i * 4 });
        script.push({ status: 'done' });
        const metrics = await runProgressLoop({
            script,
            networkOptions: { unordered: true, latencyMs: 1, jitterMs: 20 },
            settleMs: 200,
        });
        expect2(() => metrics.staleDropped > 0).toEqual(true);
        expect2(() => metrics.emitted).toEqual(metrics.applied + metrics.staleDropped);
        expect2(() => metrics.finalStates[0].status).toEqual('done');
        expect2(() => metrics.finalStates[0].seq).toEqual(metrics.emitted);
    });

    /* scenario 3: throttle - leading immediate, trailing latest-only per window */
    it('throttles updates as leading + trailing per window', () => {
        jest.useFakeTimers();
        try {
            const { messages, sink } = captureSink();
            const reporter = createProgressReporter(sink, { throttleMs: 100 });
            const task = reporter.start('t1');
            messages.length = 0; // drop the start snapshot

            task.update({ status: 'running', percent: 10 }); // leading - immediate
            task.update({ percent: 20 });
            task.update({ percent: 30 });
            expect2(() => messages.length).toEqual(1);
            expect2(() => messages[0].data.percent).toEqual(10);

            jest.advanceTimersByTime(100); // trailing - latest only
            expect2(() => messages.length).toEqual(2);
            expect2(() => messages[1].data.percent).toEqual(30);

            jest.advanceTimersByTime(1000); // no dirty change - no extra emit
            expect2(() => messages.length).toEqual(2);
            reporter.close();
        } finally {
            jest.useRealTimers();
        }
    });

    /* scenario 3: heartbeat re-emits the latest running snapshot with a new seq */
    it('re-emits running snapshots on heartbeat with increasing seq', () => {
        jest.useFakeTimers();
        try {
            const { messages, sink } = captureSink();
            const reporter = createProgressReporter(sink, { heartbeatMs: 50 });
            const task = reporter.start('t1');
            task.update({ status: 'running', percent: 42 });

            jest.advanceTimersByTime(150);
            expect2(() => messages.length).toEqual(5); // start + update + 3 heartbeats
            const seqs = messages.map(message => message.data.seq);
            expect2(() => seqs).toEqual([1, 2, 3, 4, 5]);
            expect2(() => messages[4].data.percent).toEqual(42);

            task.done();
            jest.advanceTimersByTime(200); // terminal tasks are not heartbeaten
            expect2(() => messages.length).toEqual(6);
            reporter.close();
            expect2(() => jest.getTimerCount()).toEqual(0);
        } finally {
            jest.useRealTimers();
        }
    });

    /* scenario 4: terminal semantics */
    it('emits done immediately, replaces pending throttle, and ignores later updates', () => {
        jest.useFakeTimers();
        try {
            const { messages, sink } = captureSink();
            const reporter = createProgressReporter(sink, { throttleMs: 100 });
            const task = reporter.start('t1');
            messages.length = 0;

            task.update({ status: 'running', percent: 10 }); // leading
            task.update({ percent: 50 }); // held by throttle window
            task.done({ label: 'ok' }); // bypasses throttle, cancels trailing
            expect2(() => messages.map(message => message.data.status)).toEqual(['running', 'done']);
            expect2(() => messages[1].data.percent).toEqual(50);
            expect2(() => messages[1].data.label).toEqual('ok');

            task.update({ percent: 99 }); // ignored after terminal
            task.error('nope'); // ignored after terminal
            jest.advanceTimersByTime(1000);
            expect2(() => messages.length).toEqual(2);

            expect2(() => task.state.status).toEqual('done');
            reporter.close();
        } finally {
            jest.useRealTimers();
        }
    });

    it('keeps patch fields while ignoring a status regression (running -> pending)', () => {
        const { messages, sink } = captureSink();
        const reporter = createProgressReporter(sink);
        const task = reporter.start('t1');
        task.update({ status: 'running' });
        task.update({ status: 'pending', percent: 70 });
        expect2(() => messages[2].data.status).toEqual('running');
        expect2(() => messages[2].data.percent).toEqual(70);
        reporter.close();
    });

    it('records the error summary on error()', () => {
        const { messages, sink } = captureSink();
        const reporter = createProgressReporter(sink);
        const task = reporter.start('t1');
        task.error(new Error('boom'), { label: 'failed' });
        expect2(() => messages[1].data.status).toEqual('error');
        expect2(() => messages[1].data.error).toEqual('boom');
        expect2(() => messages[1].data.label).toEqual('failed');
        reporter.close();
    });

    /* scenario 5: packet limit - oversized meta is stripped and reported */
    it('strips meta over maxPacketBytes and notifies onError', () => {
        const { messages, sink } = captureSink();
        const errors: any[] = [];
        const reporter = createProgressReporter(sink, {
            maxPacketBytes: 256,
            onError: (error, state) => errors.push({ error: `${error.message}`, id: state.id }),
        });
        const task = reporter.start('t1');
        task.update({ status: 'running', meta: { blob: 'x'.repeat(1024) } });
        const emitted = messages[1].data;
        expect2(() => emitted.meta).toEqual(undefined);
        expect2(() => emitted.status).toEqual('running');
        expect2(() => errors.length).toEqual(1);
        expect2(() => errors[0].error.includes('maxPacketBytes:256')).toEqual(true);
        reporter.close();
    });

    it('routes sink throw and rejection to onError without breaking task code', async () => {
        const errors: any[] = [];
        const reporter = createProgressReporter(
            message => {
                if (message.data.seq === 1) throw new Error('sync-fail');
                return Promise.reject(new Error('async-fail'));
            },
            { onError: error => errors.push(`${error.message}`) },
        );
        const task = reporter.start('t1');
        task.update({ status: 'running' });
        await wait(1);
        expect2(() => errors).toEqual(['sync-fail', 'async-fail']);
        task.done();
        reporter.close();
    });

    /* scenario 6: coexistence on one shared network */
    it('coexists with JSONTransport and sync traffic without cross-talk', async () => {
        const network = createNetwork({ id: 'progress-coexist' });
        const consumer = createProgressConsumer(network);
        const events: string[] = [];
        consumer.onChange(({ state }) => events.push(`${state.id}:${state.status}`));
        const transport = createJSONTransport<{ hello: string }>(network);
        const transported: any[] = [];
        transport.onMessage(data => transported.push(data));

        const reporter = createProgressReporter(message => network.send(JSON.stringify(message)));
        const task = reporter.start('job-1');
        network.send(JSON.stringify({ type: 'sync/patch', data: { id: 'job-1', seq: 999 }, mid: 's1' }));
        transport.send({ hello: 'world' });
        task.done();
        reporter.close();
        await wait();

        expect2(() => events).toEqual(['job-1:pending', 'job-1:done']);
        expect2(() => consumer.get('job-1')?.seq).toEqual(2); // sync envelope never applied
        expect2(() => transported).toEqual([{ hello: 'world' }]);
        transport.detach();
        consumer.close();
        network.close();
    });

    /* scenario 7: resource release */
    it('stops receiving after consumer.close() while the shared network stays open', async () => {
        const network = createNetwork({ id: 'progress-close' });
        const consumer = createProgressConsumer(network);
        const reporter = createProgressReporter(message => network.send(JSON.stringify(message)));
        reporter.start('t1');
        await wait();
        expect2(() => consumer.list().length).toEqual(1);

        consumer.close();
        reporter.start('t2');
        await wait();
        expect2(() => consumer.get('t2')).toEqual(undefined);
        expect2(() => network.readyState).toEqual('open');
        reporter.close();
        network.close();
    });

    it('evicts oldest terminal tasks first over maxTasks, then oldest running', async () => {
        const network = createNetwork({ id: 'progress-evict' });
        const consumer = createProgressConsumer(network, { maxTasks: 2 });
        const reporter = createProgressReporter(message => network.send(JSON.stringify(message)));
        reporter.start('a').done();
        reporter.start('b').update({ status: 'running' });
        reporter.start('c').update({ status: 'running' });
        await wait();
        expect2(() => consumer.list().map(state => state.id)).toEqual(['b', 'c']); // 'a' (terminal) evicted

        reporter.start('d').update({ status: 'running' });
        await wait();
        expect2(() => consumer.list().map(state => state.id)).toEqual(['c', 'd']); // all running - oldest evicted
        reporter.close();
        consumer.close();
        network.close();
    });

    /* scenario 8: gauges */
    it('caps the time gauge at 99 percent', () => {
        let nowMs = 1000;
        const gauge = createTimeProgressGauge(1000, () => nowMs);
        expect2(() => gauge()).toEqual({ percent: 0 });
        nowMs = 1500;
        expect2(() => gauge()).toEqual({ percent: 50 });
        nowMs = 5000;
        expect2(() => gauge()).toEqual({ percent: 99 });
    });

    it('reads percent then bufferPercent from a buffer gauge source', () => {
        let source: { percent?: number; bufferPercent?: number } | undefined;
        const gauge = createBufferProgressGauge(() => source);
        expect2(() => gauge()).toEqual({});
        source = { bufferPercent: 30 };
        expect2(() => gauge()).toEqual({ percent: 30 });
        source = { percent: 80, bufferPercent: 30 };
        expect2(() => gauge()).toEqual({ percent: 80 });
    });

    it('merges gauge into emits, prefers explicit update values, and survives gauge throw', () => {
        const { messages, sink } = captureSink();
        const errors: any[] = [];
        const reporter = createProgressReporter(sink, { onError: error => errors.push(`${error.message}`) });
        let boom = false;
        const gauge = () => {
            if (boom) throw new Error('gauge-boom');
            return { percent: 33, label: 'gauged' };
        };
        const task = reporter.start('t1', undefined, { gauge });
        expect2(() => messages[0].data.percent).toEqual(33); // gauge fills missing fields
        expect2(() => messages[0].data.label).toEqual('gauged');

        task.update({ status: 'running', percent: 90 }); // explicit wins over gauge
        expect2(() => messages[1].data.percent).toEqual(90);
        expect2(() => messages[1].data.label).toEqual('gauged');

        boom = true;
        task.update({ label: 'manual' }); // gauge throw - emit without gauge + onError
        expect2(() => messages[2].data.label).toEqual('manual');
        expect2(() => messages[2].data.percent).toEqual(90);
        expect2(() => errors).toEqual(['gauge-boom']);
        reporter.close();
    });

    it('returns the existing handle for a duplicated start(id)', () => {
        const { messages, sink } = captureSink();
        const reporter = createProgressReporter(sink);
        const task1 = reporter.start('t1', { label: 'first' });
        const task2 = reporter.start('t1', { label: 'second' });
        expect2(() => task1 === task2).toEqual(true);
        expect2(() => messages.length).toEqual(1); // no duplicated start snapshot
        reporter.close();
    });

    it('flushes the pending throttled snapshot on reporter.close()', () => {
        jest.useFakeTimers();
        try {
            const { messages, sink } = captureSink();
            const reporter = createProgressReporter(sink, { throttleMs: 10_000 });
            const task = reporter.start('t1');
            task.update({ status: 'running', percent: 10 }); // leading
            task.update({ percent: 77 }); // pending in window
            reporter.close();
            expect2(() => messages[messages.length - 1].data.percent).toEqual(77);
            expect2(() => jest.getTimerCount()).toEqual(0);
        } finally {
            jest.useRealTimers();
        }
    });

    /* throttle via loop harness - emitted stays bounded by window count + 1 */
    it('bounds emitted snapshots under throttle in the e2e loop', async () => {
        const script: Partial<ProgressState>[] = [];
        for (let i = 1; i <= 50; i++) script.push({ status: 'running', percent: i * 2 });
        const metrics = await runProgressLoop({
            script,
            reporterOptions: { throttleMs: 1_000 },
            settleMs: 30,
        });
        // start + leading + close() flush - 48 window-held updates suppressed
        expect2(() => metrics.emitted).toEqual(3);
        expect2(() => metrics.finalStates[0].percent).toEqual(100);
    });
});
