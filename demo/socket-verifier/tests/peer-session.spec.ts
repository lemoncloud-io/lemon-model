import { describe, it, expect } from 'vitest';
import { createPeerSession } from '../src/peer-session';
import { createVerifierStore } from '../src/verifier-store';
import { DEFAULT_VERIFIER_CONDITION } from '../src/types';

describe('peer-session (mode A)', () => {
    it('correlates send with its result via meta.mid', async () => {
        const store = createVerifierStore();
        const session = createPeerSession({ id: 'A', store });
        await session.connect();

        await session.send({ hello: 'world' });

        const events = store.getSnapshot().events;
        const sendEvent = events.find(e => e.kind === 'send');
        const resultEvent = events.find(e => e.kind === 'result');
        expect(sendEvent?.direction).toBe('out');
        expect(resultEvent?.direction).toBe('in');
        expect(resultEvent?.meta?.mid).toBe(sendEvent?.meta?.mid);
        expect(typeof resultEvent?.meta?.elapsedMs).toBe('number');
        expect(resultEvent?.meta?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(resultEvent?.detail).toMatch(/\(\+\d+ms\)$/);
    });

    it('resolves ping with a correlated pong', async () => {
        const store = createVerifierStore();
        const session = createPeerSession({ id: 'B', store });
        await session.connect();

        await session.ping?.({ ping: true });

        const events = store.getSnapshot().events;
        const pingEvent = events.find(e => e.kind === 'ping');
        const pongEvent = events.find(e => e.kind === 'pong');
        expect(pingEvent?.direction).toBe('out');
        expect(pongEvent?.direction).toBe('in');
        expect(pongEvent?.meta?.mid).toBe(pingEvent?.meta?.mid);
        expect(typeof pongEvent?.meta?.elapsedMs).toBe('number');
        expect(pongEvent?.meta?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(pongEvent?.detail).toMatch(/\(\+\d+ms\)$/);
    });

    it('keeps send working after reconnect', async () => {
        const store = createVerifierStore();
        const session = createPeerSession({ id: 'C', store });
        await session.connect();

        await session.reconnect();
        await expect(session.send({ after: 'reconnect' })).resolves.toBeUndefined();

        const events = store.getSnapshot().events;
        expect(events.some(e => e.kind === 'reconnect')).toBe(true);
        expect(events.filter(e => e.kind === 'result')).toHaveLength(1);
    });

    it('emits a configure event and reflects the applied condition on the connection', () => {
        const store = createVerifierStore();
        store.addConnection({
            id: 'D',
            mode: 'peer',
            status: 'connecting',
            condition: DEFAULT_VERIFIER_CONDITION,
            pendingCount: 0,
        });
        const session = createPeerSession({ id: 'D', store });

        session.configure({ ...DEFAULT_VERIFIER_CONDITION, latencyMs: 20 });

        const configureEvent = store.getSnapshot().events.find(e => e.kind === 'configure');
        expect(configureEvent?.direction).toBe('sys');
        expect(store.getSnapshot().connections[0].condition.latencyMs).toBe(20);
    });

    it('forces jitterMs to at least 1 when unordered is requested with jitterMs 0', () => {
        const store = createVerifierStore();
        store.addConnection({
            id: 'E',
            mode: 'peer',
            status: 'connecting',
            condition: DEFAULT_VERIFIER_CONDITION,
            pendingCount: 0,
        });
        const session = createPeerSession({ id: 'E', store });

        session.configure({ ...DEFAULT_VERIFIER_CONDITION, unordered: true, jitterMs: 0 });

        const configureEvent = store.getSnapshot().events.find(e => e.kind === 'configure');
        expect(configureEvent?.meta?.jitterMs).toBe(1);
        expect(store.getSnapshot().connections[0].condition.jitterMs).toBe(1);
    });

    it('surfaces a publish failure as a severity "error" event instead of a normal "out" event', async () => {
        const store = createVerifierStore();
        const session = createPeerSession({ id: 'F', store });
        await session.connect();

        // maxPacketBytes too small for the envelope forces `Peer.publish` to fail synchronously
        session.configure({ ...DEFAULT_VERIFIER_CONDITION, maxPacketBytes: 10 });
        session.post({ text: 'x'.repeat(1000) });

        const events = store.getSnapshot().events;
        const errorEvents = events.filter(e => e.severity === 'error');
        expect(errorEvents.length).toBeGreaterThan(0);
        expect(errorEvents.every(e => e.direction === 'sys' && e.kind === 'error')).toBe(true);
    });
});
