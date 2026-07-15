import { describe, it, expect } from 'vitest';
import { createVerifierStore } from '../src/verifier-store';
import { DEFAULT_VERIFIER_CONDITION } from '../src/types';

describe('verifier-store', () => {
    it('supports detached subscribe/getSnapshot (useSyncExternalStore passes them unbound)', () => {
        const store = createVerifierStore();
        const { subscribe, getSnapshot } = store;

        expect(() => getSnapshot()).not.toThrow();
        const before = getSnapshot();
        let notified = 0;
        const unsubscribe = subscribe(() => {
            notified += 1;
        });
        store.pushEvent({ connectionId: 'A', direction: 'sys', kind: 'open', severity: 'normal', detail: 'opened' });
        expect(notified).toBe(1);
        expect(getSnapshot()).not.toBe(before);
        unsubscribe();
    });

    it('assigns monotonically increasing seq numbers to pushed events', () => {
        const store = createVerifierStore();

        const e1 = store.pushEvent({
            connectionId: 'A',
            direction: 'sys',
            kind: 'open',
            severity: 'normal',
            detail: 'opened',
        });
        const e2 = store.pushEvent({
            connectionId: 'A',
            direction: 'out',
            kind: 'send',
            severity: 'normal',
            detail: 'sent',
        });
        const e3 = store.pushEvent({
            connectionId: 'A',
            direction: 'in',
            kind: 'result',
            severity: 'normal',
            detail: 'resolved',
        });

        expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
        expect(store.getSnapshot().events.map(e => e.seq)).toEqual([1, 2, 3]);
    });

    it('transitions connection state via addConnection/updateConnection/removeConnection', () => {
        const store = createVerifierStore();
        const connection = {
            id: 'A',
            mode: 'peer' as const,
            status: 'connecting' as const,
            condition: DEFAULT_VERIFIER_CONDITION,
            pendingCount: 0,
        };

        store.addConnection(connection);
        expect(store.getSnapshot().connections).toEqual([connection]);

        store.updateConnection('A', { status: 'open' });
        expect(store.getSnapshot().connections[0].status).toBe('open');
        expect(store.getSnapshot().connections[0].id).toBe('A');

        store.removeConnection('A');
        expect(store.getSnapshot().connections).toEqual([]);
    });

    it('notifies subscribers on state changes', () => {
        const store = createVerifierStore();
        let notified = 0;
        const unsubscribe = store.subscribe(() => {
            notified++;
        });

        store.pushEvent({ connectionId: 'A', direction: 'sys', kind: 'open', severity: 'normal', detail: 'opened' });
        expect(notified).toBe(1);

        unsubscribe();
        store.pushEvent({ connectionId: 'A', direction: 'sys', kind: 'close', severity: 'normal', detail: 'closed' });
        expect(notified).toBe(1);
    });

    it('derives a pending event only when pendingCount increases, and updates connection state', () => {
        const store = createVerifierStore();
        store.addConnection({
            id: 'A',
            mode: 'ws',
            status: 'open',
            condition: DEFAULT_VERIFIER_CONDITION,
            pendingCount: 0,
        });

        store.notePendingCount('A', 1);
        let pendingEvents = store.getSnapshot().events.filter(e => e.kind === 'pending');
        expect(pendingEvents).toHaveLength(1);
        expect(store.getSnapshot().connections[0].pendingCount).toBe(1);

        store.notePendingCount('A', 1); // unchanged -> no new pending event
        pendingEvents = store.getSnapshot().events.filter(e => e.kind === 'pending');
        expect(pendingEvents).toHaveLength(1);

        store.notePendingCount('A', 0); // decrease -> no new pending event
        pendingEvents = store.getSnapshot().events.filter(e => e.kind === 'pending');
        expect(pendingEvents).toHaveLength(1);
        expect(store.getSnapshot().connections[0].pendingCount).toBe(0);

        store.notePendingCount('A', 3); // increase again -> new pending event
        pendingEvents = store.getSnapshot().events.filter(e => e.kind === 'pending');
        expect(pendingEvents).toHaveLength(2);
        expect(store.getSnapshot().connections[0].pendingCount).toBe(3);
    });
});
