/**
 * `logtrace/logtrace.spec.ts`
 * - reporter batching + consumer ring buffer tests over the in-memory socket simulator.
 */
import { expect2 } from '../cores/index.spec';
import { createNetwork } from '../socket/socket';
import { SocketMessage } from '../socket/types';
import { createFilteredNetwork } from '../socket/websocket';
import { createJSONTransport } from '../socket/transport';
import { createLogTraceConsumer, createLogTraceReporter, LogTraceBatch, LogTraceEntry } from './logtrace';
import { runLogTraceLoop } from './testing';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

/** capture sink for reporter-side tests (no network) */
const captureSink = () => {
    const batches: SocketMessage<LogTraceBatch>[] = [];
    const sink = (message: SocketMessage<LogTraceBatch>): void => {
        batches.push(message);
    };
    return { batches, sink };
};

/** build a raw log:trace envelope for consumer-side wire tests */
const rawBatch = (source: string, entries: Partial<LogTraceEntry>[], mid = 'l0') =>
    JSON.stringify({
        type: 'log:trace',
        data: {
            source,
            entries: entries.map((e, i) => ({ level: 'info', ts: 1000 + i, message: `m${i}`, seq: i + 1, ...e })),
        },
        mid,
    });

describe('LogTrace', () => {
    it('scenario 1: e2e - mixed levels reach onEntry in batch order and list() is (ts, seq) sorted', async () => {
        //! the simulator is unordered by default; pin ordered delivery to assert cross-batch onEntry order.
        const network = createNetwork({ id: 'logtrace-e2e', unordered: false });
        const consumer = createLogTraceConsumer(network);
        const seen: LogTraceEntry[] = [];
        consumer.onEntry(entry => seen.push(entry));
        const reporter = createLogTraceReporter(message => network.send(JSON.stringify(message)), {
            source: 'box-1',
            flushCount: 3,
            flushIntervalMs: 0,
        });

        // Count flushes the first three entries; error forces the final one out.
        reporter.debug('d');
        reporter.info('i', { productId: 'P1' });
        reporter.warn('w'); // 3rd entry -> flushCount flush
        reporter.error('e'); // error -> immediate flush
        await wait();

        expect2(() => seen.map(entry => entry.level)).toEqual(['debug', 'info', 'warn', 'error']);
        expect2(() => seen.map(entry => entry.seq)).toEqual([1, 2, 3, 4]);
        expect2(() => seen[0].source).toEqual('box-1');
        expect2(() => seen[1].json).toEqual({ productId: 'P1' });
        expect2(() => consumer.list().map(entry => entry.seq)).toEqual([1, 2, 3, 4]);
        expect2(() => consumer.list({ minLevel: 'warn' }).map(entry => entry.level)).toEqual(['warn', 'error']);
        expect2(() => consumer.list({ limit: 2 }).map(entry => entry.seq)).toEqual([3, 4]);
        expect2(() => consumer.gapCount).toEqual(0);

        consumer.close();
        network.close();
    });

    it('scenario 2: flushCount reaching triggers flush', () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, { source: 's', flushIntervalMs: 0 });
        for (let i = 0; i < 40; i++) reporter.info(`m${i}`);

        expect2(() => batches.length).toEqual(2);
        expect2(() => batches[0].type).toEqual('log:trace');
        expect2(() => batches[0].mid).toEqual('l1');
        expect2(() => batches[1].mid).toEqual('l2');
        expect2(() => batches[0].data.source).toEqual('s');
        expect2(() => batches[0].data.entries.length).toEqual(20);
        expect2(() => batches[1].data.entries[19].seq).toEqual(40);
        reporter.close();
    });

    it('scenario 2: first batch flushes immediately (leading), then flushIntervalMs batches (lazy timer)', () => {
        jest.useFakeTimers();
        try {
            const { batches, sink } = captureSink();
            const reporter = createLogTraceReporter(sink, { source: 's' });
            //! leading edge: the very first entry must reach the viewer without waiting a window.
            reporter.info('first');
            expect2(() => batches.length).toEqual(1);
            reporter.info('second');
            jest.advanceTimersByTime(249);
            expect2(() => batches.length).toEqual(1);
            jest.advanceTimersByTime(1);
            expect2(() => batches.length).toEqual(2);
            expect2(() => batches[1].data.entries.length).toEqual(1);
            //! timer is lazy: it must restart from the NEXT first entry, not keep firing.
            jest.advanceTimersByTime(1000);
            expect2(() => batches.length).toEqual(2);
            reporter.close();
        } finally {
            jest.useRealTimers();
        }
    });

    it('scenario 2: maxBatchBytes splits the batch right before exceeding the budget', () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, { source: 's', flushIntervalMs: 0, maxBatchBytes: 300 });
        const message = 'x'.repeat(100); // one entry is ~160 bytes serialized
        reporter.info(message);
        reporter.info(message); // would exceed 300 -> flush [1st], start new batch
        reporter.info(message);
        reporter.close();

        expect2(() => batches.length).toEqual(3);
        expect2(() => batches.map(batch => batch.data.entries.length)).toEqual([1, 1, 1]);
        expect2(() => batches.every(batch => byteLength(JSON.stringify(batch.data.entries)) <= 300)).toEqual(true);
    });

    it('scenario 2: error level flushes immediately', () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, { source: 's', flushCount: 100, flushIntervalMs: 0 });
        reporter.info('pending');
        expect2(() => batches.length).toEqual(0);
        reporter.error('boom');
        expect2(() => batches.length).toEqual(1);
        expect2(() => batches[0].data.entries.map(entry => entry.level)).toEqual(['info', 'error']);
        reporter.close();
    });

    it('scenario 3: an oversized entry drops json, cuts message, and notifies onError', () => {
        const { batches, sink } = captureSink();
        const errors: { error: any; entries: LogTraceEntry[] }[] = [];
        const reporter = createLogTraceReporter(sink, {
            source: 's',
            flushIntervalMs: 0,
            maxBatchBytes: 256,
            onError: (error, entries) => errors.push({ error, entries }),
        });

        reporter.info('big json', { blob: 'x'.repeat(500) });
        reporter.flush();
        expect2(() => batches[0].data.entries[0].json).toEqual(undefined);
        expect2(() => batches[0].data.entries[0].truncated).toEqual(true);
        expect2(() => batches[0].data.entries[0].message).toEqual('big json');
        expect2(() => errors.length).toEqual(1);

        reporter.info('y'.repeat(1000));
        reporter.flush();
        const cut = batches[1].data.entries[0];
        expect2(() => cut.truncated).toEqual(true);
        expect2(() => cut.message.length < 1000).toEqual(true);
        expect2(() => byteLength(JSON.stringify(cut)) <= 256).toEqual(true);
        expect2(() => errors.length).toEqual(2);
        reporter.close();
    });

    it('scenario 3: sink throw/reject goes to onError and never breaks the caller (at-most-once)', async () => {
        const errors: any[] = [];
        const throwing = createLogTraceReporter(
            () => {
                throw new Error('send fail');
            },
            { source: 's', flushIntervalMs: 0, onError: error => errors.push(error) },
        );
        throwing.info('a');
        throwing.flush();
        expect2(() => errors.length).toEqual(1);
        throwing.close();

        const rejecting = createLogTraceReporter(() => Promise.reject(new Error('async fail')), {
            source: 's',
            flushIntervalMs: 0,
            onError: error => errors.push(error),
        });
        rejecting.info('b');
        rejecting.flush();
        await wait();
        expect2(() => errors.length).toEqual(2);
        rejecting.close();
    });

    it('scenario 4: unordered delivery still lists (ts, seq) ascending without gap inflation', async () => {
        const metrics = await runLogTraceLoop({
            entries: Array.from({ length: 8 }, (_, i) => ({ level: 'info' as const, message: `m${i}` })),
            reporterOptions: { source: 's', flushCount: 1, flushIntervalMs: 0 },
            networkOptions: { id: 'logtrace-unordered', unordered: true, jitterMs: 5, latencyMs: 1 },
            settleMs: 100,
        });

        expect2(() => metrics.batches).toEqual(8);
        expect2(() => metrics.delivered).toEqual(8);
        expect2(() => metrics.gapCount).toEqual(0);
        expect2(() => metrics.finalEntries.map(entry => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('scenario 4: gapCount counts wire loss exactly; late/duplicate arrivals do not inflate it', async () => {
        const network = createNetwork({ id: 'logtrace-gap' });
        const consumer = createLogTraceConsumer(network);
        network.send(rawBatch('s', [{ seq: 1, ts: 1001 }], 'l1'));
        network.send(rawBatch('s', [{ seq: 3, ts: 1003 }], 'l3'));
        await wait();
        expect2(() => consumer.gapCount).toEqual(1); // seq 2 not seen yet

        network.send(rawBatch('s', [{ seq: 2, ts: 1002 }], 'l2')); // late arrival heals the gap
        await wait();
        expect2(() => consumer.gapCount).toEqual(0);
        expect2(() => consumer.list().map(entry => entry.seq)).toEqual([1, 2, 3]);

        network.send(rawBatch('s', [{ seq: 2, ts: 1002 }], 'l2')); // duplicate seq is ignored (defensive)
        await wait();
        expect2(() => consumer.gapCount).toEqual(0);
        expect2(() => consumer.list().length).toEqual(3);

        consumer.close();
        network.close();
    });

    it('scenario 5: level gates are independent on both ends', async () => {
        //! reporter gate: filtered levels get no seq -> no artificial gap.
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, { source: 's', minLevel: 'info', flushIntervalMs: 0 });
        reporter.debug('dropped');
        reporter.info('kept');
        reporter.flush();
        expect2(() => batches[0].data.entries.map(entry => [entry.message, entry.seq])).toEqual([['kept', 1]]);
        reporter.close();

        //! consumer gate: below-minLevel entries are counted for loss BEFORE being discarded.
        const network = createNetwork({ id: 'logtrace-gate' });
        const consumer = createLogTraceConsumer(network, { minLevel: 'warn' });
        const seen: LogTraceEntry[] = [];
        consumer.onEntry(entry => seen.push(entry));
        network.send(
            rawBatch('s', [
                { level: 'info', seq: 1 },
                { level: 'warn', seq: 2 },
            ]),
        );
        await wait();
        expect2(() => seen.map(entry => entry.level)).toEqual(['warn']);
        expect2(() => consumer.list().length).toEqual(1);
        expect2(() => consumer.gapCount).toEqual(0);
        consumer.close();
        network.close();
    });

    it('scenario 6: ring buffer evicts the oldest over maxEntries and clear() empties retention', async () => {
        const network = createNetwork({ id: 'logtrace-ring' });
        const consumer = createLogTraceConsumer(network, { maxEntries: 3 });
        const reporter = createLogTraceReporter(message => network.send(JSON.stringify(message)), {
            source: 's',
            flushIntervalMs: 0,
        });
        for (let i = 1; i <= 5; i++) reporter.info(`m${i}`);
        reporter.close();
        await wait();

        expect2(() => consumer.list().map(entry => entry.seq)).toEqual([3, 4, 5]);
        consumer.clear();
        expect2(() => consumer.list()).toEqual([]);
        expect2(() => consumer.gapCount).toEqual(0); // loss accounting survives clear()
        consumer.close();
        network.close();
    });

    it('scenario 7: coexists with JSONTransport and other envelope traffic on one network', async () => {
        const network = createNetwork({ id: 'logtrace-coexist' });
        const consumer = createLogTraceConsumer(network);
        const traceSeen: LogTraceEntry[] = [];
        consumer.onEntry(entry => traceSeen.push(entry));
        const json = createJSONTransport<{ data: { text: string } }>(
            createFilteredNetwork(network, raw => raw.includes('"type":"json:')),
        );
        const jsonSeen: any[] = [];
        json.onMessage(data => jsonSeen.push(data));

        // Other envelope types share the socket but should stay invisible to logtrace.
        network.send(JSON.stringify({ type: 'sync/put', data: { any: 1 }, mid: 'm1' }));
        network.send(JSON.stringify({ type: 'progress:update', data: { percent: 10 }, mid: 'p1' }));
        json.send({ data: { text: 'hello' } });
        const reporter = createLogTraceReporter(message => network.send(JSON.stringify(message)), {
            source: 's',
            flushIntervalMs: 0,
        });
        reporter.info('log-line');
        reporter.close();
        await wait(30);

        expect2(() => traceSeen.map(entry => entry.message)).toEqual(['log-line']);
        expect2(() => jsonSeen).toEqual([{ data: { text: 'hello' } }]);
        expect2(() => json.pendingCount).toEqual(0);

        json.detach();
        consumer.close();
        network.close();
    });

    it('scenario 8: reporter.close flushes the remainder and ignores later logs; consumer.close keeps the network open', async () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, { source: 's', flushCount: 100, flushIntervalMs: 0 });
        reporter.info('remainder');
        reporter.close();
        expect2(() => batches.length).toEqual(1);
        reporter.info('ignored');
        reporter.flush();
        expect2(() => batches.length).toEqual(1);

        const network = createNetwork({ id: 'logtrace-close' });
        //! keep one raw listener so the simulator accepts sends after the consumer unsubscribes.
        network.onMessage(() => undefined);
        const consumer = createLogTraceConsumer(network);
        const seen: LogTraceEntry[] = [];
        consumer.onEntry(entry => seen.push(entry));
        consumer.close();
        network.send(rawBatch('s', [{ seq: 1 }]));
        await wait();
        expect2(() => seen).toEqual([]);
        expect2(() => network.readyState).toEqual('open');
        network.close();
    });

    it('scenario 9: two sources interleave without dedup misfire and gapCount stays per-source', async () => {
        const network = createNetwork({ id: 'logtrace-multi-source' });
        const consumer = createLogTraceConsumer(network);
        const sink = (message: SocketMessage<LogTraceBatch>) => network.send(JSON.stringify(message));
        const a = createLogTraceReporter(sink, { source: 'a', flushCount: 1, flushIntervalMs: 0 });
        const b = createLogTraceReporter(sink, { source: 'b', flushCount: 1, flushIntervalMs: 0 });

        a.info('a1');
        b.info('b1');
        a.info('a2');
        b.info('b2');
        a.close();
        b.close();
        await wait();

        //! both reporters start seq at 1 - the source key must keep them apart.
        expect2(() => consumer.list().length).toEqual(4);
        expect2(() =>
            consumer
                .list()
                .map(entry => `${entry.source}${entry.seq}`)
                .sort(),
        ).toEqual(['a1', 'a2', 'b1', 'b2']);
        expect2(() => consumer.gapCount).toEqual(0);
        const listed = consumer.list();
        expect2(() => listed.every((entry, i) => i === 0 || compare(listed[i - 1], entry) <= 0)).toEqual(true);

        consumer.close();
        network.close();
    });

    it('harness: packet limit is respected end to end (metrics-based)', async () => {
        const metrics = await runLogTraceLoop({
            entries: Array.from({ length: 100 }, (_, i) => ({ level: 'info' as const, message: `line-${i}` })),
            reporterOptions: { source: 's', maxPacketBytes: 2 * 1024, flushIntervalMs: 0 },
            networkOptions: { id: 'logtrace-packet-limit', maxPacketBytes: 2 * 1024 },
            settleMs: 60,
        });

        expect2(() => metrics.delivered).toEqual(100);
        expect2(() => metrics.truncated).toEqual(0);
        expect2(() => metrics.gapCount).toEqual(0);
        expect2(() => metrics.maxPacketBytes <= 2 * 1024).toEqual(true);
        expect2(() => metrics.batches >= 5).toEqual(true); // 100 entries cannot fit in fewer than 5 batches at 20/flush
        expect2(() => metrics.finalEntries.length).toEqual(100);
    });

    it('scenario 10: custom type/typePrefix routes batches to a dedicated consumer without cross-talk', async () => {
        const network = createNetwork({ id: 'logtrace-custom-type' });
        const defaultConsumer = createLogTraceConsumer(network); // prefix 'log:'
        const appConsumer = createLogTraceConsumer(network, { typePrefix: 'app:' }); // prefix 'app:'
        const defaultSeen: LogTraceEntry[] = [];
        const appSeen: LogTraceEntry[] = [];
        defaultConsumer.onEntry(entry => defaultSeen.push(entry));
        appConsumer.onEntry(entry => appSeen.push(entry));

        const defaultReporter = createLogTraceReporter(message => network.send(JSON.stringify(message)), {
            source: 's1',
            flushIntervalMs: 0,
        });
        const appReporter = createLogTraceReporter(message => network.send(JSON.stringify(message)), {
            type: 'app:trace',
            source: 's2',
            flushIntervalMs: 0,
        });
        // Routing is decided by envelope type, not by source or message content.
        defaultReporter.info('default-msg');
        appReporter.info('app-msg');
        defaultReporter.close();
        appReporter.close();
        await wait();

        expect2(() => defaultSeen.map(entry => entry.message)).toEqual(['default-msg']);
        expect2(() => appSeen.map(entry => entry.message)).toEqual(['app-msg']);
        defaultConsumer.close();
        appConsumer.close();
        network.close();
    });

    it('scenario 10: consumer silently skips broken JSON, null data, and invalid entry fields', async () => {
        const network = createNetwork({ id: 'logtrace-robustness' });
        const consumer = createLogTraceConsumer(network);
        const seen: LogTraceEntry[] = [];
        consumer.onEntry(entry => seen.push(entry));

        //! passes the substring filter but is not parseable JSON -> JSON.parse catch
        network.send('"type":"log:trace not valid json');
        //! valid JSON, matching type, but data is null -> batch shape check fails
        network.send(JSON.stringify({ type: 'log:trace', data: null, mid: 'm1' }));
        //! valid batch shape but entries contain a mix of valid and invalid entries
        network.send(
            JSON.stringify({
                type: 'log:trace',
                data: {
                    source: 's',
                    entries: [
                        { level: 'info', ts: 1000, message: 'valid', seq: 1 },
                        { level: 'bad-level', ts: 1000, message: 'invalid-level', seq: 2 },
                        { level: 'info', ts: 1000, message: 'no-seq' },
                        { level: 'info', ts: 1000, message: 'zero-seq', seq: 0 },
                    ],
                },
                mid: 'm2',
            }),
        );
        await wait();

        expect2(() => seen.map(entry => entry.message)).toEqual(['valid']);
        consumer.close();
        network.close();
    });

    it('emitError is a no-op when onError is not set (sink throw without onError)', () => {
        //! covers the this.onError?. undefined branch: emitError called but onError not registered
        const reporter = createLogTraceReporter(
            () => {
                throw new Error('sink fail');
            },
            { source: 's', flushIntervalMs: 0 },
        );
        reporter.info('x');
        expect2(() => reporter.flush()).toEqual(undefined); // must not throw
        reporter.close();
    });

    it('reporter created with no options uses all defaults (covers options?. short-circuit branches)', () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink);
        reporter.info('hello');
        reporter.close();
        expect2(() => batches[0].type).toEqual('log:trace');
        expect2(() => batches[0].data.entries[0].message).toEqual('hello');
        expect2(() => typeof batches[0].data.source).toEqual('string'); // auto-generated source
    });

    it('emitError swallows a throwing onError without breaking the reporter', () => {
        const { batches, sink } = captureSink();
        const reporter = createLogTraceReporter(sink, {
            source: 's',
            flushIntervalMs: 0,
            maxBatchBytes: 128,
            onError: () => {
                throw new Error('observer boom');
            },
        });
        reporter.info('msg', { blob: 'x'.repeat(500) }); // oversized -> truncate -> emitError -> catch
        reporter.flush();
        expect2(() => batches[0].data.entries[0].truncated).toEqual(true);
        reporter.close();
    });

    it('list() returns tail slice on limit, empty on limit:0, all on negative limit', async () => {
        const network = createNetwork({ id: 'logtrace-list-edge' });
        const consumer = createLogTraceConsumer(network);
        network.send(
            rawBatch('s', [
                { seq: 1, ts: 100 },
                { seq: 2, ts: 200 },
                { seq: 3, ts: 300 },
            ]),
        );
        await wait();

        // limit keeps the newest tail; non-positive limits are explicit edge cases.
        expect2(() => consumer.list().length).toEqual(3);
        expect2(() => consumer.list({ limit: 2 }).map(entry => entry.seq)).toEqual([2, 3]); // tail-2
        expect2(() => consumer.list({ limit: 0 }).length).toEqual(0); // 0 -> empty
        expect2(() => consumer.list({ limit: -1 }).length).toEqual(3); // negative -> all
        consumer.close();
        network.close();
    });
});

const compare = (a: LogTraceEntry, b: LogTraceEntry): number => a.ts - b.ts || a.seq - b.seq;
