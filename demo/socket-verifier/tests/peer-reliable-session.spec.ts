import { describe, it, expect } from 'vitest';
import { createPeerReliableSession } from '../src/peer-reliable-session';
import { createVerifierStore } from '../src/verifier-store';
import { DEFAULT_VERIFIER_CONDITION } from '../src/types';

describe('peer-reliable-session (권장 진입점 · reliable 왕복)', () => {
    it('send 왕복이 send(out) → ack(in) → result(in) 세 이벤트로 드러난다', async () => {
        const store = createVerifierStore();
        const session = createPeerReliableSession({ id: 'A', store });
        await session.connect();

        await session.send({ hello: 'reliable' });

        const events = store.getSnapshot().events;
        const sendEvent = events.find(e => e.kind === 'send');
        const ackEvent = events.find(e => e.kind === 'ack');
        const resultEvent = events.find(e => e.kind === 'result');

        expect(sendEvent?.direction).toBe('out');
        expect(ackEvent?.direction).toBe('in');
        expect(ackEvent?.meta?.tid).toBeTruthy();
        expect(resultEvent?.direction).toBe('in');
        expect(resultEvent?.meta?.mid).toBe(sendEvent?.meta?.mid);
        expect(typeof resultEvent?.meta?.elapsedMs).toBe('number');
        expect(resultEvent?.meta?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(resultEvent?.detail).toMatch(/\(\+\d+ms\)$/);
    });

    it('open 이벤트를 먼저 방출하고 이후 send가 정상 왕복한다', async () => {
        const store = createVerifierStore();
        const session = createPeerReliableSession({ id: 'B', store });
        await session.connect();

        const openEvent = store.getSnapshot().events.find(e => e.kind === 'open');
        expect(openEvent?.direction).toBe('sys');

        await expect(session.send({ n: 1 })).resolves.toBeUndefined();
        expect(store.getSnapshot().events.filter(e => e.kind === 'result')).toHaveLength(1);
    });

    it('emits a configure event and reflects the applied condition on the connection', () => {
        const store = createVerifierStore();
        store.addConnection({
            id: 'C',
            mode: 'peer',
            status: 'connecting',
            condition: DEFAULT_VERIFIER_CONDITION,
            pendingCount: 0,
            reliable: true,
        });
        const session = createPeerReliableSession({ id: 'C', store });

        session.configure({ ...DEFAULT_VERIFIER_CONDITION, latencyMs: 15 });

        const configureEvent = store.getSnapshot().events.find(e => e.kind === 'configure');
        expect(configureEvent?.direction).toBe('sys');
        expect(store.getSnapshot().connections[0].condition.latencyMs).toBe(15);
    });
});
