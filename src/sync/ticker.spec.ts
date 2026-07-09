/**
 * `ticker.spec.ts`
 * - opt-in tick utility test: interval cadence, failure backoff (+ cap), restore on success, stop().
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import { createSyncTicker } from './ticker';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('ticker', () => {
    it('should not tick before start(), and start() should be idempotent while running', async () => {
        let calls = 0;
        const ticker = createSyncTicker(
            async () => {
                calls++;
            },
            { intervalMs: 15 },
        );

        expect2(() => ticker.running).toEqual(false);
        await wait(30);
        expect2(() => calls).toEqual(0);

        ticker.start();
        ticker.start(); // re-entrant start() is a no-op
        expect2(() => ticker.running).toEqual(true);
        await wait(70); // ~4-5 ticks at 15ms apart; generous margin against scheduler jitter
        expect2(() => calls >= 3).toEqual(true);

        ticker.stop();
    });

    it('should back off exponentially on repeated failure (capped), and restore intervalMs on success', async () => {
        let calls = 0;
        let shouldFail = false;
        const ticker = createSyncTicker(
            async () => {
                calls++;
                if (shouldFail) throw new Error('tick failed');
            },
            { intervalMs: 15, factor: 2, maxMs: 60 },
        );

        ticker.start();
        await wait(70); // steady cadence: several ticks land in this window
        const steadyCalls = calls;
        expect2(() => steadyCalls >= 3).toEqual(true);

        // failing ticks: delay climbs 15 -> 30 -> 60(capped), so far fewer calls land in the same window
        shouldFail = true;
        await wait(70);
        const failingCalls = calls - steadyCalls;
        expect2(() => failingCalls < steadyCalls).toEqual(true);

        // let any already-scheduled long-backoff tick land and succeed, then resume intervalMs(15ms) cadence
        shouldFail = false;
        await wait(80);
        const recoveredBaseline = calls;
        await wait(70);
        expect2(() => calls - recoveredBaseline >= 3).toEqual(true);

        ticker.stop();
    });

    it('should stop scheduling further ticks after stop(), and allow a fresh start() afterward', async () => {
        let calls = 0;
        const ticker = createSyncTicker(
            async () => {
                calls++;
            },
            { intervalMs: 15 },
        );

        ticker.start();
        await wait(40);
        ticker.stop();
        expect2(() => ticker.running).toEqual(false);

        const afterStop = calls;
        await wait(40);
        expect2(() => calls).toEqual(afterStop);

        ticker.start();
        await wait(40);
        expect2(() => calls > afterStop).toEqual(true);
    });

    it('should not spawn a second chain when start() follows stop() while a tick is in flight', async () => {
        let inflight = 0;
        let maxInflight = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => (release = resolve));
        let calls = 0;
        const ticker = createSyncTicker(
            async () => {
                calls++;
                inflight++;
                maxInflight = Math.max(maxInflight, inflight);
                if (calls === 1) await gate; // hold the first tick in flight to open the stop/start window
                else await wait(8); // longer than intervalMs: two live chains would be forced to overlap
                inflight--;
            },
            { intervalMs: 5 },
        );

        ticker.start();
        await wait(15); // first tick is now in flight, blocked on the gate
        ticker.stop();
        ticker.start(); // restart while the old tick is still pending
        release(); // the old tick settles now - its completion must not reschedule a stale chain
        await wait(60);
        ticker.stop();

        expect2(() => maxInflight).toEqual(1); // a duplicated chain would have produced overlapping ticks
    });
});
