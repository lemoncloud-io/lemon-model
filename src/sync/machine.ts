/**
 * `sync/machine.ts`
 * - L4 sync machine: model type registration, local state, updatedAt freshness, pull/event application.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { SocketMessage, SocketUnsubscribe } from '../socket';
import {
    ModelSyncOptions,
    ModelSyncSupportable,
    SocketClientSupportable,
    SyncChangeEvent,
    SyncMachineSupportable,
    SyncProtocolAdapter,
    SyncTarget,
} from './types';

/** envelope types the machine never treats as a domain event, even if `Peer`/L3 forward them */
const NON_EVENT_TYPES = new Set(['result', 'error', 'ping', 'pong']);

/** create the L4 sync machine over an L3 socket client */
export const createSyncMachine = (client: SocketClientSupportable): SyncMachineSupportable => new SyncMachine(client);

/** L4 machine: registry of per-type handles + one shared event fan-out subscription */
class SyncMachine implements SyncMachineSupportable {
    private readonly handles = new Map<string, ModelSyncHandle<any>>();
    private readonly unsubscribe: SocketUnsubscribe;
    private closed = false;

    public constructor(private readonly client: SocketClientSupportable) {
        this.unsubscribe = client.onMessage(message => this.dispatchEvent(message));
    }

    /** register a domain model type. re-registering the same type returns the existing handle and ignores the new options */
    public register<M extends SyncTarget>(type: string, options: ModelSyncOptions<M>): ModelSyncSupportable<M> {
        if (!type) throw new Error(`@type (string) is required - syncMachine.register`);
        if (this.closed) throw new Error(`@syncMachine is closed - syncMachine.register(${type})`);
        const existing = this.handles.get(type);
        if (existing) return existing as ModelSyncSupportable<M>;

        const handle = new ModelSyncHandle<M>(type, this.client, options.adapter, () => this.handles.delete(type));
        this.handles.set(type, handle);

        if (options.initialPull ?? true) handle.pull().catch(() => undefined);
        return handle;
    }

    /** pull every registered type once. a type whose pull is already in flight is skipped, not nested */
    public async tick(): Promise<void> {
        await Promise.all([...this.handles.values()].map(handle => handle.pull().catch(() => undefined)));
    }

    /** detach everything */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribe();
        for (const handle of [...this.handles.values()]) handle.close();
        this.handles.clear();
    }

    private dispatchEvent(message: SocketMessage): void {
        if (NON_EVENT_TYPES.has(message.type)) return;
        for (const handle of [...this.handles.values()]) handle.applyEvent(message);
    }
}

/** sync handle for a single model type: local store, watermark, freshness judgement */
class ModelSyncHandle<M extends SyncTarget> implements ModelSyncSupportable<M> {
    public readonly type: string;
    private readonly store = new Map<string, M>();
    private readonly changeListeners = new Set<(event: SyncChangeEvent<M>) => void>();
    private watermark = 0;
    private pulling?: Promise<M[]>;
    private closed = false;

    public constructor(
        type: string,
        private readonly client: SocketClientSupportable,
        private readonly adapter: SyncProtocolAdapter<M>,
        private readonly onClose: () => void,
    ) {
        this.type = type;
    }

    /** read-only local state lookup */
    public get(id: string): M | undefined {
        return this.store.get(id);
    }

    public list(): M[] {
        return [...this.store.values()];
    }

    /** pull changes since the watermark and apply them. loops the cursor until parseReply.next is absent */
    public pull(): Promise<M[]> {
        if (this.closed) return Promise.reject(new Error(`@handle[${this.type}] is closed - modelSync.pull`));
        if (this.pulling) return this.pulling; // already in flight: join it instead of nesting a new pull
        const promise = this.doPull().finally(() => {
            if (this.pulling === promise) this.pulling = undefined;
        });
        this.pulling = promise;
        return promise;
    }

    /** subscribe to change notifications */
    public onChange(handler: (event: SyncChangeEvent<M>) => void): SocketUnsubscribe {
        this.changeListeners.add(handler);
        return () => this.changeListeners.delete(handler);
    }

    /** detach this type's subscriptions/listeners */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.changeListeners.clear();
        this.onClose();
    }

    /** apply a server-sent event owned by this type (called by the machine's fan-out) */
    public applyEvent(message: SocketMessage): void {
        if (this.closed) return;
        const models = this.adapter.parseEvent(message);
        if (!models) return; // not owned by this type
        const changed = this.applyModels(models);
        if (changed.length) this.emitChange('event', changed);
    }

    private async doPull(): Promise<M[]> {
        const since = this.watermark || undefined;
        let cursor: any;
        const applied: M[] = [];

        for (;;) {
            const { type, data } = this.adapter.buildPull(since, cursor);
            const reply = await this.client.request<any, any>(type, data);
            const page = this.adapter.parseReply(reply);
            const appliedPage = this.applyModels(page.models ?? []);
            //! watermark advances from pull-applied models ONLY — an event-advanced watermark would
            //! let a lost event skip the pulled backfill of models updated in between (safety-net hole).
            for (const model of appliedPage) this.watermark = Math.max(this.watermark, model.updatedAt ?? 0);
            //! emit per page so applied pages are notified even if a later page request fails.
            if (appliedPage.length) this.emitChange('pull', appliedPage);
            applied.push(...appliedPage);
            cursor = page.next;
            if (!cursor) break;
        }

        return applied;
    }

    /** apply the updatedAt freshness rule to each incoming model; returns the ones actually applied/removed */
    private applyModels(models: M[]): M[] {
        const changed: M[] = [];
        for (const model of models) {
            if (this.applyOne(model)) changed.push(model);
        }
        return changed;
    }

    private applyOne(incoming: M): boolean {
        if (incoming?.id == null || incoming?.updatedAt == null) return false; // no updatedAt: ignore
        const local = this.store.get(incoming.id);
        if (!local && incoming.deletedAt) return false; // delete of something already absent: ignore

        if (local) {
            const localUpdatedAt = local.updatedAt;
            if (localUpdatedAt != null && incoming.updatedAt <= localUpdatedAt) return false; // stale or same value: ignore
            // local.updatedAt == null: local is stale by definition, fall through and overwrite
        }

        if (incoming.deletedAt) this.store.delete(incoming.id);
        else this.store.set(incoming.id, incoming);
        return true;
    }

    private emitChange(cause: 'pull' | 'event', models: M[]): void {
        const event: SyncChangeEvent<M> = { cause, models };
        for (const listener of [...this.changeListeners]) listener(event);
    }
}
