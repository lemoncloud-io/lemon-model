/**
 * `sync/ticker.ts`
 * - opt-in tick utility for the service-side tick-owning point. works over any `() => Promise` (machine-agnostic).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
export interface SyncTickerOptions {
    /** steady-state period */
    intervalMs: number;
    /** exponential backoff multiplier on failure (default 2) */
    factor?: number;
    /** backoff delay cap (default 60_000ms) */
    maxMs?: number;
}

export interface SyncTickerSupportable {
    start(): void;
    stop(): void;
    readonly running: boolean;
}

/** create a self-rescheduling ticker: no overlap, backoff on failure, restore on success */
export const createSyncTicker = (tick: () => Promise<unknown>, options: SyncTickerOptions): SyncTickerSupportable =>
    new SyncTicker(tick, options);

class SyncTicker implements SyncTickerSupportable {
    private readonly factor: number;
    private readonly maxMs: number;
    private delayMs: number;
    private timer?: ReturnType<typeof setTimeout>;
    private _running = false;
    /** bumped on every start()/stop(): an in-flight tick from an old epoch must not reschedule a second chain */
    private epoch = 0;

    public constructor(private readonly tick: () => Promise<unknown>, private readonly options: SyncTickerOptions) {
        this.factor = options.factor ?? 2;
        this.maxMs = options.maxMs ?? 60_000;
        this.delayMs = options.intervalMs;
    }

    public get running(): boolean {
        return this._running;
    }

    public start(): void {
        if (this._running) return; // re-entrant start() is a no-op
        this._running = true;
        this.epoch++;
        this.delayMs = this.options.intervalMs;
        this.schedule(this.epoch);
    }

    public stop(): void {
        this._running = false;
        this.epoch++;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule(epoch: number): void {
        if (!this._running || epoch !== this.epoch) return;
        this.timer = setTimeout(() => this.run(epoch), this.delayMs);
    }

    /** the next tick is scheduled only after this one settles (setTimeout chain) - no overlap */
    private run(epoch: number): void {
        this.tick().then(
            () => {
                if (epoch !== this.epoch) return; // stale chain (stopped/restarted while in flight)
                this.delayMs = this.options.intervalMs;
                this.schedule(epoch);
            },
            () => {
                if (epoch !== this.epoch) return; // stale chain (stopped/restarted while in flight)
                this.delayMs = Math.min(this.delayMs * this.factor, this.maxMs);
                this.schedule(epoch);
            },
        );
    }
}
