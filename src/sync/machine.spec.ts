/**
 * `machine.spec.ts`
 * - L4 sync machine test.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, GETERR } from '../cores/index.spec';
import { createFilteredNetwork } from '../socket';
import { createJSONTransport, splitJSON } from '../socket/transport';
import { createNetwork } from '../socket/testing';
import { CoreModel } from '../types';
import { createSocketClient } from './client';
import { createSyncMachine } from './machine';
import { createPeerBridge, PeerBridge } from './testing';
import { SyncProtocolAdapter } from './types';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

interface UserModel extends CoreModel<'user'> {
    name?: string;
}

const createUserAdapter = (): SyncProtocolAdapter<UserModel> => ({
    buildPull: (since, cursor) => ({ type: 'sync/user:pull', data: { since, cursor } }),
    parseReply: data => ({ models: data?.models ?? [], next: data?.next }),
    parseEvent: message => (message.type === 'sync/user:updated' ? (message.data as UserModel[]) : undefined),
});

let evtNo = 0;
const pushUserEvent = (bridge: PeerBridge, models: UserModel[]) => {
    bridge.server.post(
        { type: 'sync/user:updated', data: models, mid: `evt-${++evtNo}` },
        { clientId: bridge.clientId },
    );
    return wait();
};

/** simulated server band for the `user` sync type: pull pagination + error injection + event push */
const attachUserServer = (bridge: PeerBridge, pageSize?: number) => {
    let users: UserModel[] = [];
    let failOnce = false;
    let pullCount = 0;
    let lastSince: number | undefined;

    bridge.server.onMessage((message: { type: string; data: any; mid: string }) => {
        if (message.type !== 'sync/user:pull') throw new Error(`@type[${message.type}] unhandled - test.userServer`);
        pullCount++;
        lastSince = message.data?.since;
        if (failOnce) {
            failOnce = false;
            bridge.server.post(
                { type: 'error', data: { message: 'pull failed' }, mid: message.mid },
                { clientId: bridge.clientId },
            );
            //! `Peer.dispatch` turns ANY listener return value (even `undefined`) into a second,
            //! automatic `result` reply for the same mid. Throwing instead of returning keeps this
            //! explicit `error` post the only reply, so it can't lose a race against a spurious one.
            throw new Error(`@type[${message.type}] replied manually - test.userServer`);
        }
        const since: number = message.data?.since ?? 0;
        const cursor: number = message.data?.cursor ?? 0;
        const matching = users.filter(user => (user.updatedAt ?? 0) > since);
        const size = pageSize ?? (matching.length || 1);
        const page = matching.slice(cursor, cursor + size);
        const next = cursor + size < matching.length ? cursor + size : undefined;
        return { models: page, next };
    });

    return {
        setUsers: (list: UserModel[]) => (users = list),
        failNextPull: () => (failOnce = true),
        get pullCount() {
            return pullCount;
        },
        get lastSince() {
            return lastSince;
        },
    };
};

/** versionOf(seq) axis target — no updatedAt anywhere (SyncTarget admits it unchanged) */
interface TaskState {
    id?: string;
    seq?: number;
    deletedAt?: number;
    percent?: number;
}

const createTaskAdapter = (): SyncProtocolAdapter<TaskState> => ({
    versionOf: task => task.seq,
    buildPull: (since, cursor) => ({ type: 'sync/task:pull', data: { since, cursor } }),
    parseReply: data => ({ models: data?.models ?? [] }),
    parseEvent: message => (message.type === 'sync/task:updated' ? (message.data as TaskState[]) : undefined),
});

const pushTaskEvent = (bridge: PeerBridge, models: TaskState[]) => {
    bridge.server.post(
        { type: 'sync/task:updated', data: models, mid: `evt-${++evtNo}` },
        { clientId: bridge.clientId },
    );
    return wait();
};

describe('machine', () => {
    it('should apply the initial pull after register by default', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge).setUsers([{ id: 'u1', type: 'user', updatedAt: 100, name: 'Ann' }]);

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter() });
        await wait();

        expect2(() => users.list()).toEqual([{ id: 'u1', type: 'user', updatedAt: 100, name: 'Ann' }]);
        expect2(() => users.get('u1')?.name).toEqual('Ann');
    });

    it('should leave register valid when the initial pull fails, and pull from scratch on the next pull', async () => {
        const bridge = createPeerBridge();
        const userServer = attachUserServer(bridge);
        userServer.setUsers([{ id: 'u1', type: 'user', updatedAt: 100 }]);
        userServer.failNextPull();

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter() });
        await wait();
        expect2(() => users.list()).toEqual([]);

        const applied = await users.pull();
        expect2(() => applied.map(u => u.id)).toEqual(['u1']);
        expect2(() => userServer.lastSince).toEqual(undefined); // started from scratch, not from a partially-advanced watermark
        expect2(() => users.list().map(u => u.id)).toEqual(['u1']);
    });

    it('should page through the cursor loop and apply every page', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge, 1).setUsers([
            { id: 'u1', type: 'user', updatedAt: 100 },
            { id: 'u2', type: 'user', updatedAt: 200 },
        ]);

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });
        const changes: string[] = [];
        users.onChange(event => changes.push(`${event.cause}:${event.models.length}`));

        const applied = await users.pull();
        expect2(() => applied.map(u => u.id).sort()).toEqual(['u1', 'u2']);
        expect2(() => changes).toEqual(['pull:1', 'pull:1']); // per-page emit: applied pages notify even if a later page fails
        expect2(() =>
            users
                .list()
                .map(u => u.id)
                .sort(),
        ).toEqual(['u1', 'u2']);
    });

    it('should apply server events and never treat result/error/ping/pong as domain events', async () => {
        const bridge = createPeerBridge();
        const userServer = attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });
        const changes: string[] = [];
        users.onChange(event => changes.push(event.cause));

        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 100, name: 'Ann' }]);
        expect2(() => users.get('u1')?.name).toEqual('Ann');
        expect2(() => changes).toEqual(['event']);

        // reserved/settlement types must never reach parseEvent, even sent as raw envelopes bypassing Peer
        bridge.serverNetwork.send(JSON.stringify({ type: 'ping', data: {}, mid: 'p-1' }));
        bridge.serverNetwork.send(JSON.stringify({ type: 'pong', data: {}, mid: 'p-2' }));
        bridge.serverNetwork.send(JSON.stringify({ type: 'result', data: {}, mid: 'never-requested' }));
        bridge.serverNetwork.send(JSON.stringify({ type: 'error', data: {}, mid: 'never-requested-2' }));
        await wait();
        expect2(() => changes).toEqual(['event']);

        // events never advance the watermark: the next pull still starts from scratch,
        // so a lost event can always be backfilled by pull (safety net preserved)
        await users.pull();
        expect2(() => userServer.lastSince).toEqual(undefined);
    });

    it('should apply the updatedAt freshness rules exactly as specified', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        // deletedAt for a model that is not locally present: ignored
        await pushUserEvent(bridge, [{ id: 'ghost', type: 'user', updatedAt: 100, deletedAt: 100 }]);
        expect2(() => users.get('ghost')).toEqual(undefined);

        // new model applies
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 100, name: 'v1' }]);
        expect2(() => users.get('u1')?.name).toEqual('v1');

        // older updatedAt: ignored
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 50, name: 'stale' }]);
        expect2(() => users.get('u1')?.name).toEqual('v1');

        // same updatedAt: ignored
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 100, name: 'same' }]);
        expect2(() => users.get('u1')?.name).toEqual('v1');

        // missing updatedAt on the incoming model: ignored
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', name: 'no-updatedAt' } as UserModel]);
        expect2(() => users.get('u1')?.name).toEqual('v1');

        // newer updatedAt applies
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 200, name: 'v2' }]);
        expect2(() => users.get('u1')?.name).toEqual('v2');

        // deletedAt that passes freshness removes the model
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 300, deletedAt: 300 }]);
        expect2(() => users.get('u1')).toEqual(undefined);
    });

    it('should treat a local model missing updatedAt as stale and overwrite it', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        // this local state (updatedAt missing) is unreachable through the public, read-only contract —
        // applyOne() never stores a model without updatedAt. seed it directly to exercise the documented
        // "local model has no updatedAt -> treat as stale" rule.
        (users as unknown as { store: Map<string, UserModel> }).store.set('u1', {
            id: 'u1',
            type: 'user',
            name: 'no-updatedAt',
        });

        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 10, name: 'overwritten' }]);
        expect2(() => users.get('u1')).toEqual({ id: 'u1', type: 'user', updatedAt: 10, name: 'overwritten' });
    });

    it('should reject pull() on a server error without mutating the store', async () => {
        const bridge = createPeerBridge();
        const userServer = attachUserServer(bridge);
        userServer.setUsers([{ id: 'u1', type: 'user', updatedAt: 100 }]);
        userServer.failNextPull();

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        const error = await users.pull().catch(e => e);
        expect2(() => error).toEqual({ message: 'pull failed' });
        expect2(() => users.list()).toEqual([]);
    });

    it("should skip a nested tick() while a type's pull is already in flight", async () => {
        const bridge = createPeerBridge();
        const userServer = attachUserServer(bridge);
        userServer.setUsers([{ id: 'u1', type: 'user', updatedAt: 100 }]);

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        await Promise.all([machine.tick(), machine.tick()]);
        await wait();

        expect2(() => userServer.pullCount).toEqual(1);
        expect2(() =>
            users
                .list()
                .map(u => u.id)
                .sort(),
        ).toEqual(['u1']);
    });

    it('should return the same handle on re-registration and ignore new options', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);

        const first = machine.register('user', { adapter: createUserAdapter(), initialPull: false });
        const neverUsed: SyncProtocolAdapter<UserModel> = {
            buildPull: () => {
                throw new Error('should never be called');
            },
            parseReply: () => ({ models: [] }),
            parseEvent: () => undefined,
        };
        const second = machine.register('user', { adapter: neverUsed, initialPull: false });

        expect2(() => second === first).toEqual(true);
    });

    it('should sync a non-CoreModel target that only satisfies SyncTarget (id/updatedAt)', async () => {
        interface JobStatus {
            id?: string;
            updatedAt?: number;
            progress?: number;
        }
        const bridge = createPeerBridge();
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const jobs = machine.register<JobStatus>('genai:job', {
            adapter: {
                buildPull: (since, cursor) => ({ type: 'sync/job:pull', data: { since, cursor } }),
                parseReply: data => ({ models: data?.models ?? [] }),
                parseEvent: message => (message.type === 'sync/job:progress' ? [message.data as JobStatus] : undefined),
            },
            initialPull: false,
        });

        bridge.server.post(
            { type: 'sync/job:progress', data: { id: 'j1', updatedAt: 100, progress: 42 }, mid: 'evt-job-1' },
            { clientId: bridge.clientId },
        );
        await wait();

        expect2(() => jobs.get('j1')).toEqual({ id: 'j1', updatedAt: 100, progress: 42 });
    });

    it('should judge freshness on an injected versionOf axis (seq) without updatedAt', async () => {
        const bridge = createPeerBridge();
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const tasks = machine.register<TaskState>('task', { adapter: createTaskAdapter(), initialPull: false });

        // new model applies on the seq axis
        await pushTaskEvent(bridge, [{ id: 't1', seq: 3, percent: 10 }]);
        expect2(() => tasks.get('t1')?.percent).toEqual(10);

        // lower/equal seq: ignored
        await pushTaskEvent(bridge, [{ id: 't1', seq: 2, percent: 5 }]);
        await pushTaskEvent(bridge, [{ id: 't1', seq: 3, percent: 7 }]);
        expect2(() => tasks.get('t1')?.percent).toEqual(10);

        // missing seq on the incoming model: ignored (versionOf undefined)
        await pushTaskEvent(bridge, [{ id: 't1', percent: 99 }]);
        expect2(() => tasks.get('t1')?.percent).toEqual(10);

        // higher seq applies
        await pushTaskEvent(bridge, [{ id: 't1', seq: 4, percent: 50 }]);
        expect2(() => tasks.get('t1')?.percent).toEqual(50);

        // local model missing seq: stale by definition, overwritten (seeded directly — unreachable via the public contract)
        (tasks as unknown as { store: Map<string, TaskState> }).store.set('t2', { id: 't2', percent: 1 });
        await pushTaskEvent(bridge, [{ id: 't2', seq: 1, percent: 2 }]);
        expect2(() => tasks.get('t2')).toEqual({ id: 't2', seq: 1, percent: 2 });

        // tombstone missing the axis value: silently dropped, the delete never lands (server contract premise 3)
        await pushTaskEvent(bridge, [{ id: 't1', deletedAt: 100 }]);
        expect2(() => tasks.get('t1')?.percent).toEqual(50);

        // tombstone carrying the axis value passes freshness and removes (deletedAt rule is orthogonal to the axis)
        await pushTaskEvent(bridge, [{ id: 't1', seq: 5, deletedAt: 100 }]);
        expect2(() => tasks.get('t1')).toEqual(undefined);
    });

    it('should advance the watermark on the versionOf axis from pull-applied models only', async () => {
        const bridge = createPeerBridge();
        let taskList: TaskState[] = [];
        let lastSince: number | undefined;
        bridge.server.onMessage((message: { type: string; data: any; mid: string }) => {
            if (message.type !== 'sync/task:pull') throw new Error(`@type[${message.type}] unhandled - test.taskServer`);
            lastSince = message.data?.since;
            const since: number = message.data?.since ?? 0;
            return { models: taskList.filter(task => (task.seq ?? 0) > since) };
        });

        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const tasks = machine.register<TaskState>('task', { adapter: createTaskAdapter(), initialPull: false });

        // first pull starts from scratch and applies everything
        taskList = [
            { id: 't1', seq: 3 },
            { id: 't2', seq: 7 },
        ];
        await tasks.pull();
        expect2(() => lastSince).toEqual(undefined);
        expect2(() => tasks.list().length).toEqual(2);

        // the next pull carries since = max(seq) of the pull-applied models
        await tasks.pull();
        expect2(() => lastSince).toEqual(7);

        // an event never advances the watermark, even with a higher seq (safety net is axis-independent)
        await pushTaskEvent(bridge, [{ id: 't3', seq: 50 }]);
        expect2(() => tasks.get('t3')?.seq).toEqual(50);
        await tasks.pull();
        expect2(() => lastSince).toEqual(7);
    });

    it('should guard register()/pull() after close()', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        users.close();
        const pullError = await users.pull().catch(GETERR);
        expect2(() => pullError.includes('is closed')).toEqual(true);

        machine.close();
        expect2(() => machine.register('user', { adapter: createUserAdapter(), initialPull: false })).toEqual(
            '@syncMachine is closed - syncMachine.register(user)',
        );
    });

    it('should stop notifying onChange handlers after unsubscribe', async () => {
        const bridge = createPeerBridge();
        attachUserServer(bridge);
        const client = createSocketClient(bridge.network);
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });
        const changes: any[] = [];
        const unsubscribe = users.onChange(event => changes.push(event));

        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 100 }]);
        expect2(() => changes.length).toEqual(1);

        unsubscribe();
        await pushUserEvent(bridge, [{ id: 'u1', type: 'user', updatedAt: 200 }]);
        expect2(() => changes.length).toEqual(1);
    });

    it('should coexist with JSONTransport traffic and a raw progress string stream on one network', async () => {
        const network = createNetwork();

        // simulated server band, sharing the raw bus: replies to sync/user:pull only.
        network.onMessage(raw => {
            let message: any;
            try {
                message = JSON.parse(raw);
            } catch {
                return;
            }
            if (message?.type === 'sync/user:pull') {
                network.send(
                    JSON.stringify({
                        type: 'result',
                        data: { models: [{ id: 'u1', type: 'user', updatedAt: 100 }] },
                        mid: message.mid,
                    }),
                );
            }
        });

        // sync runtime: filtered to its own namespace + the generic result/error settlement types.
        const syncFilter = (raw: string) => {
            try {
                const type = JSON.parse(raw)?.type;
                return typeof type === 'string' && (type.startsWith('sync/') || type === 'result' || type === 'error');
            } catch {
                return false;
            }
        };
        const client = createSocketClient(network, { filter: syncFilter });
        const machine = createSyncMachine(client);
        const users = machine.register('user', { adapter: createUserAdapter(), initialPull: false });

        // JSONTransport traffic, filtered to json:* packets only (mirrors `genai/transport.ts`).
        const isJsonPacket = (raw: string) => {
            try {
                return `${JSON.parse(raw)?.type ?? ''}`.startsWith('json:');
            } catch {
                return false;
            }
        };
        const jsonReceived: any[] = [];
        const jsonTransport = createJSONTransport(createFilteredNetwork(network, isJsonPacket));
        jsonTransport.onMessage(data => jsonReceived.push(data));

        // a raw, non-JSON progress string stream sharing the same bus.
        const progress: string[] = [];
        network.onMessage(raw => {
            if (raw.startsWith('progress:')) progress.push(raw);
        });

        splitJSON({ type: 'genai:stream', seq: 1 }).send(network);
        network.send('progress:10');
        network.send('progress:42');
        const applied = await users.pull();

        await wait();

        expect2(() => applied.map(u => u.id)).toEqual(['u1']);
        expect2(() => users.list().map(u => u.id)).toEqual(['u1']);
        expect2(() => jsonReceived).toEqual([{ type: 'genai:stream', seq: 1 }]);
        //! the shared network defaults to unordered delivery with jitter; assert the convergent set, not arrival order.
        expect2(() => [...progress].sort()).toEqual(['progress:10', 'progress:42']);
    });
});
