/**
 * `progress/progress.ts`
 * - one-way (server -> client) task progress reporting over a shared WebSocket.
 * - contract + reporter + gauges + consumer in one file (see SPEC.md - SSOT).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { NetworkSupportable, SocketMessage, SocketUnsubscribe } from '../socket/types';
import { createFilteredNetwork } from '../socket/websocket';

/** default serialized packet size limit (same family as `src/socket`) */
export const DEFAULT_MAX_PACKET_BYTES = 64 * 1024;

/** task execution status */
export type ProgressStatus = 'pending' | 'running' | 'done' | 'error';

/** progress snapshot of one task - the unit that travels the wire */
export interface ProgressState {
    /** task id (assigned by the service) */
    id: string;
    /** execution status */
    status: ProgressStatus;
    /** 0~100 progress ratio (omitted when not measurable) */
    percent?: number;
    /** current step / total steps */
    step?: number;
    totalSteps?: number;
    /** human-readable current step description */
    label?: string;
    /** error summary when status is error */
    error?: string;
    /** emitted timestamp (epoch ms) - display only */
    ts: number;
    /** reporter-wide monotonic sequence - latest-wins judgement */
    seq: number;
    /** service-defined extra info. keep it small (see packet limit) */
    meta?: Record<string, any>;
}

/** measurement produced by a gauge - subset merged into snapshots */
export type ProgressMeasure = Partial<Pick<ProgressState, 'percent' | 'step' | 'totalSteps' | 'label'>>;

/**
 * progress measurement strategy - separates "how" percent is computed from the reporter.
 * must be a pure read with no side effects. one function fits every strategy.
 */
export type ProgressGauge = () => ProgressMeasure;

/** time-flow gauge - elapsed ratio against expectedMs, capped at 99% (only done() declares completion) */
export const createTimeProgressGauge = (expectedMs: number, now: () => number = Date.now): ProgressGauge => {
    const startedAt = now();
    return () => {
        if (!(expectedMs > 0)) return { percent: 99 };
        const percent = Math.floor(((now() - startedAt) / expectedMs) * 100);
        return { percent: Math.min(99, Math.max(0, percent)) };
    };
};

/** buffer-fill gauge - reads percent/bufferPercent from a GenAIStreamProgress-compatible source (structural type, no src/buffer dependency) */
export const createBufferProgressGauge = (
    source: () => { percent?: number; bufferPercent?: number } | undefined,
): ProgressGauge => {
    return () => {
        const snapshot = source();
        const percent = snapshot?.percent ?? snapshot?.bufferPercent;
        return percent === undefined ? {} : { percent };
    };
};

/** server-side send path injection (Ports & Adapters). a rejected Promise is wired to onError */
export type ProgressSink = (message: SocketMessage<ProgressState>) => void | Promise<void>;

export interface ProgressReporterOptions {
    /** envelope type (default 'progress:update') */
    type?: string;
    /** update() emit coalescing window. 0 emits every update immediately (default 0) */
    throttleMs?: number;
    /** re-emit interval for running snapshots. 0 disables (default 0) */
    heartbeatMs?: number;
    /** serialized size limit. an oversized snapshot is emitted without meta and reported via onError (default DEFAULT_MAX_PACKET_BYTES = 64kb) */
    maxPacketBytes?: number;
    /** observe emit failures / size overruns */
    onError?: (error: any, state: ProgressState) => void;
}

/** reporting handle for one task */
export interface ProgressTaskSupportable {
    readonly id: string;
    /** current local snapshot */
    readonly state: ProgressState;
    /** patch then emit (throttled). ignored after done/error. status regression (running -> pending) drops status only, rest of the patch applies */
    update(
        patch: Partial<Omit<ProgressState, 'id' | 'ts' | 'seq' | 'status'>> & { status?: 'pending' | 'running' },
    ): void;
    /** transition to a terminal status and emit immediately (throttle bypassed). later update is ignored */
    done(patch?: Partial<Pick<ProgressState, 'label' | 'meta'>>): void;
    error(error: string | Error, patch?: Partial<Pick<ProgressState, 'label' | 'meta'>>): void;
}

/** start options for one task */
export interface ProgressTaskOptions {
    /** percent auto-measurement strategy. gauge() is merged into the snapshot right before update/heartbeat emits. explicit update values win over gauge */
    gauge?: ProgressGauge;
}

export interface ProgressReporterSupportable {
    /** declare a task start and get its handle. calling again with the same id returns the existing handle */
    start(
        id: string,
        initial?: Partial<Pick<ProgressState, 'label' | 'percent' | 'step' | 'totalSteps' | 'meta'>>,
        options?: ProgressTaskOptions,
    ): ProgressTaskSupportable;
    /** flush unemitted snapshots + release timers. must be called before the lambda invocation ends */
    close(): void;
}

/** change notification */
export interface ProgressChangeEvent {
    state: ProgressState;
    /** true when this consumer sees the task for the first time */
    created: boolean;
}

export interface ProgressConsumerOptions {
    /** inbound type prefix (default 'progress:') */
    typePrefix?: string;
    /** retained task count limit. evicts oldest terminal (done/error) tasks first (default 100) */
    maxTasks?: number;
}

export interface ProgressConsumerSupportable {
    /** latest snapshot by task id */
    get(id: string): ProgressState | undefined;
    /** every retained snapshot - in first-applied order (seq is per-reporter, not a cross-task sort key) */
    list(): ProgressState[];
    /** subscribe to applied changes (stale drops are not notified) */
    onChange(handler: (event: ProgressChangeEvent) => void): SocketUnsubscribe;
    /** unsubscribe. the network stays open (shared socket) */
    close(): void;
}

const GAUGE_KEYS: (keyof ProgressMeasure)[] = ['percent', 'step', 'totalSteps', 'label'];
const textEncoder = new TextEncoder();
const byteLength = (value: string): number => textEncoder.encode(value).length;

/** assign only defined values so a partial patch never erases fields */
const assignDefined = (target: Record<string, any>, patch?: Record<string, any>): void => {
    if (!patch) return;
    for (const key of Object.keys(patch)) {
        if (patch[key] !== undefined) target[key] = patch[key];
    }
};

interface ProgressTaskInternal {
    handle: ProgressTaskSupportable;
    /** explicit-only local state; gauge values are merged per emitted snapshot */
    local: ProgressState;
    /** last emitted snapshot (gauge merged) */
    last: ProgressState;
    gauge?: ProgressGauge;
    /** open throttle window timer */
    timer?: ReturnType<typeof setTimeout>;
    /** local changes not yet emitted within the current throttle window */
    dirty: boolean;
    /** terminal (done/error) - every later update is ignored */
    closed: boolean;
}

/** create a server-side progress reporter over an injected sink */
export const createProgressReporter = (
    sink: ProgressSink,
    options?: ProgressReporterOptions,
): ProgressReporterSupportable => {
    const type = options?.type ?? 'progress:update';
    const throttleMs = options?.throttleMs ?? 0;
    const heartbeatMs = options?.heartbeatMs ?? 0;
    const maxPacketBytes = options?.maxPacketBytes ?? DEFAULT_MAX_PACKET_BYTES;
    const tasks = new Map<string, ProgressTaskInternal>();
    let seq = 0;
    let mid = 0;

    const notifyError = (error: any, state: ProgressState): void => options?.onError?.(error, state);

    /** the reporter never interrupts task code: sink throw/reject only reaches onError */
    const dispatch = (message: SocketMessage<ProgressState>): void => {
        try {
            const result = sink(message);
            if (result && typeof result.then === 'function') {
                result.then(undefined, error => notifyError(error, message.data));
            }
        } catch (error) {
            notifyError(error, message.data);
        }
    };

    const emit = (task: ProgressTaskInternal): void => {
        task.dirty = false;
        const snapshot: ProgressState = { ...task.local, ts: Date.now(), seq: ++seq };
        if (task.gauge) {
            try {
                const measure = task.gauge();
                for (const key of GAUGE_KEYS) {
                    if (snapshot[key] === undefined && measure[key] !== undefined)
                        (snapshot as any)[key] = measure[key];
                }
            } catch (error) {
                notifyError(error, snapshot);
            }
        }
        let message: SocketMessage<ProgressState> = { type, data: snapshot, mid: `p${++mid}` };
        if (snapshot.meta !== undefined && byteLength(JSON.stringify(message)) > maxPacketBytes) {
            const { meta: _meta, ...stripped } = snapshot;
            message = { ...message, data: stripped };
            notifyError(new Error(`progress packet exceeds maxPacketBytes:${maxPacketBytes}`), snapshot);
        }
        task.last = message.data;
        dispatch(message);
    };

    /** trailing edge: emit the latest snapshot once per window while updates keep arriving */
    const openWindow = (task: ProgressTaskInternal): void => {
        task.timer = setTimeout(() => {
            task.timer = undefined;
            if (!task.dirty || task.closed) return;
            emit(task);
            openWindow(task);
        }, throttleMs);
    };

    const cancelWindow = (task: ProgressTaskInternal): void => {
        if (!task.timer) return;
        clearTimeout(task.timer);
        task.timer = undefined;
    };

    const finish = (task: ProgressTaskInternal, status: 'done' | 'error', patch?: Record<string, any>): void => {
        if (task.closed) return;
        task.closed = true;
        cancelWindow(task);
        assignDefined(task.local, patch);
        task.local.status = status;
        emit(task);
    };

    const heartbeatTimer =
        heartbeatMs > 0
            ? setInterval(() => {
                  tasks.forEach(task => {
                      if (!task.closed && task.local.status === 'running') emit(task);
                  });
              }, heartbeatMs)
            : undefined;

    return {
        start: (id, initial, taskOptions) => {
            const existing = tasks.get(id);
            if (existing) return existing.handle;

            const local: ProgressState = { id, status: 'pending', ts: 0, seq: 0 };
            assignDefined(local, initial);
            const task: ProgressTaskInternal = {
                local,
                last: local,
                gauge: taskOptions?.gauge,
                dirty: false,
                closed: false,
                handle: {
                    id,
                    get state() {
                        return task.last;
                    },
                    update: patch => {
                        if (task.closed) return;
                        const { status, ...rest } = patch ?? {};
                        if (status && !(status === 'pending' && task.local.status === 'running')) {
                            task.local.status = status;
                        }
                        assignDefined(task.local, rest);
                        if (throttleMs <= 0) return emit(task);
                        if (task.timer) {
                            task.dirty = true;
                            return;
                        }
                        emit(task);
                        openWindow(task);
                    },
                    done: patch => finish(task, 'done', patch),
                    error: (error, patch) => {
                        task.local.error = typeof error === 'string' ? error : `${error?.message ?? error}`;
                        finish(task, 'error', patch);
                    },
                },
            };
            tasks.set(id, task);
            emit(task);
            return task.handle;
        },
        close: () => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            tasks.forEach(task => {
                cancelWindow(task);
                if (task.dirty && !task.closed) emit(task);
            });
        },
    };
};

/** create a client-side progress consumer on a shared network */
export const createProgressConsumer = (
    network: NetworkSupportable,
    options?: ProgressConsumerOptions,
): ProgressConsumerSupportable => {
    const typePrefix = options?.typePrefix ?? 'progress:';
    const maxTasks = Math.max(1, options?.maxTasks ?? 100);
    const rawKey = `"type":"${typePrefix}`;
    /** two-stage filter: raw substring check (no parse) then parsed type re-check */
    const filtered = createFilteredNetwork(network, raw => raw.includes(rawKey));
    const store = new Map<string, ProgressState>();
    const handlers = new Set<(event: ProgressChangeEvent) => void>();

    const evict = (keepId: string): void => {
        if (store.size <= maxTasks) return;
        let evictId: string | undefined;
        for (const [id, state] of store) {
            if (id !== keepId && (state.status === 'done' || state.status === 'error')) {
                evictId = id;
                break;
            }
        }
        if (evictId === undefined) {
            for (const id of store.keys()) {
                if (id !== keepId) {
                    evictId = id;
                    break;
                }
            }
        }
        if (evictId !== undefined) store.delete(evictId);
    };

    const unsubscribe = filtered.onMessage(raw => {
        let message: SocketMessage<ProgressState>;
        try {
            message = JSON.parse(raw);
        } catch {
            return;
        }
        if (typeof message?.type !== 'string' || !message.type.startsWith(typePrefix)) return;
        const state = message.data;
        if (!state || typeof state.id !== 'string' || typeof state.seq !== 'number') return;
        const existing = store.get(state.id);
        if (existing && state.seq <= existing.seq) return;
        store.set(state.id, state);
        if (!existing) evict(state.id);
        for (const handler of [...handlers]) {
            try {
                handler({ state, created: !existing });
            } catch {
                // a subscriber error must not break other subscribers or the shared network
            }
        }
    });

    return {
        get: id => store.get(id),
        list: () => [...store.values()],
        onChange: handler => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        close: () => {
            unsubscribe();
            handlers.clear();
        },
    };
};
