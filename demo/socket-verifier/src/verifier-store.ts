/** React-independent store for the shared verifier UI: ConnectionState[] + TimelineEvent[] (02-design.md) */
import type { ConnectionState, TimelineEvent } from './types';

/** timeline event input; `seq`/`at` are assigned by the store */
export type NewTimelineEvent = Omit<TimelineEvent, 'seq' | 'at'>;

/** snapshot shape compatible with React's `useSyncExternalStore` */
export interface VerifierStoreSnapshot {
    connections: ConnectionState[];
    events: TimelineEvent[];
}

export interface VerifierStore {
    subscribe(listener: () => void): () => void;
    getSnapshot(): VerifierStoreSnapshot;
    addConnection(connection: ConnectionState): void;
    updateConnection(id: string, patch: Partial<Omit<ConnectionState, 'id'>>): void;
    removeConnection(id: string): void;
    pushEvent(event: NewTimelineEvent): TimelineEvent;
    clearEvents(): void;
    notePendingCount(connectionId: string, count: number): void;
}

class VerifierStoreImpl implements VerifierStore {
    private connections: ConnectionState[] = [];
    private events: TimelineEvent[] = [];
    private snapshot: VerifierStoreSnapshot = { connections: this.connections, events: this.events };
    private readonly listeners = new Set<() => void>();
    private readonly pendingCounts = new Map<string, number>();
    private seq = 0;

    /** arrow properties: React's useSyncExternalStore invokes these detached from the instance */
    public subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    public getSnapshot = (): VerifierStoreSnapshot => {
        return this.snapshot;
    };

    public addConnection(connection: ConnectionState): void {
        this.connections = [...this.connections, connection];
        this.commit();
    }

    public updateConnection(id: string, patch: Partial<Omit<ConnectionState, 'id'>>): void {
        let changed = false;
        this.connections = this.connections.map(item => {
            if (item.id !== id) return item;
            changed = true;
            return { ...item, ...patch };
        });
        if (changed) this.commit();
    }

    public removeConnection(id: string): void {
        const next = this.connections.filter(item => item.id !== id);
        if (next.length === this.connections.length) return;
        this.connections = next;
        this.pendingCounts.delete(id);
        this.commit();
    }

    public pushEvent(event: NewTimelineEvent): TimelineEvent {
        const $event: TimelineEvent = { ...event, seq: ++this.seq, at: Date.now() };
        this.events = [...this.events, $event];
        this.commit();
        return $event;
    }

    public clearEvents(): void {
        this.events = [];
        this.pendingCounts.clear();
        this.commit();
    }

    public notePendingCount(connectionId: string, count: number): void {
        const prev = this.pendingCounts.get(connectionId) ?? 0;
        this.pendingCounts.set(connectionId, count);
        if (count > prev) {
            this.pushEvent({
                connectionId,
                direction: 'sys',
                kind: 'pending',
                severity: 'normal',
                detail: `pending +${count - prev} (total ${count})`,
                meta: { pendingCount: count, prevPendingCount: prev },
            });
        }
        this.updateConnection(connectionId, { pendingCount: count });
    }

    private commit(): void {
        this.snapshot = { connections: this.connections, events: this.events };
        for (const listener of [...this.listeners]) listener();
    }
}

/** create a fresh, independent verifier store instance */
export const createVerifierStore = (): VerifierStore => new VerifierStoreImpl();
