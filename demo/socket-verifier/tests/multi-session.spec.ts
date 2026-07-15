import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startMockServer } from '../mock-server.mjs';
import { createWsSession, type WsVerifierSession } from '../src/ws-session';
import { createMultiSession, type MultiSession } from '../src/multi-session';
import { createVerifierStore, type VerifierStore } from '../src/verifier-store';
import { DEFAULT_VERIFIER_CONDITION, type ConnectionState } from '../src/types';
import { MULTI_NETWORK_SCOPE } from '@socket/multi';

/** node has no global WebSocket in this runtime target; inject the `ws` package (same as ws-session.spec.ts) */
(globalThis as any).WebSocket = WebSocket;

const waitFor = async (predicate: () => boolean, timeoutMs = 2000, intervalMs = 20): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
};

const initialConnection = (id: string): ConnectionState => ({
    id,
    mode: 'ws',
    status: 'connecting',
    condition: DEFAULT_VERIFIER_CONDITION,
    pendingCount: 0,
});

describe('multi-session extension (mode B 패널의 Sockets 섹션)', () => {
    let wss: ReturnType<typeof startMockServer>;
    let url: string;
    let store: VerifierStore;
    let session: WsVerifierSession;
    let multi: MultiSession | undefined;

    beforeEach(async () => {
        wss = startMockServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => wss.once('listening', () => resolve()));
        const address = wss.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        url = `ws://127.0.0.1:${port}`;
        store = createVerifierStore();
        store.addConnection(initialConnection('A'));
        session = createWsSession({ id: 'A', url, store });
        await session.connect();
        multi = undefined;
    });

    afterEach(async () => {
        multi?.detach();
        session.close();
        await new Promise<void>(resolve => wss.close(() => resolve()));
    });

    const attach = (): MultiSession => {
        const primary = session.getPrimaryNetwork();
        if (!primary) throw new Error('primary not connected');
        multi = createMultiSession({ id: 'A', store, primary, mainUrl: url });
        return multi;
    };

    /** sequentially add `count` backup sockets (S1, S2, ...) to reach an N = count+1 configuration */
    const addBackups = async (session: MultiSession, count: number): Promise<void> => {
        for (let i = 0; i < count; i += 1) await session.addSocket(url);
    };

    it('attach 시 S0 소켓 행이 즉시 sockets 배열에 반영된다', () => {
        attach();

        const connection = store.getSnapshot().connections.find(c => c.id === 'A');
        expect(connection?.sockets).toEqual([{ index: 0, url, status: 'open' }]);
    });

    it('Add Socket 시 S1 handshake 이벤트가 발생하고 sockets 배열이 2행으로 갱신된다', async () => {
        const m = attach();
        await m.addSocket(url);

        const handshake = store.getSnapshot().events.find(e => e.kind === 'handshake' && e.meta?.socketIndex === 1);
        expect(handshake).toBeDefined();
        expect(handshake?.direction).toBe('in');

        const connection = store.getSnapshot().connections.find(c => c.id === 'A');
        expect(connection?.sockets).toHaveLength(2);
        expect(connection?.sockets?.[1]).toMatchObject({ index: 1, status: 'open' });
        expect(connection?.status).toBe('open'); // S0/transport unaffected by adding a backup
    });

    it('sendAll 1회 전송 시(N=2) 같은 mid의 첫 도착은 receive, 나머지 재도착은 duplicate로 파생된다', async () => {
        const m = attach();
        await addBackups(m, 1);

        m.sendAll({ hello: 'multi' });

        // mock server broadcasts every inbound frame to every connected client (crosstalk, 패널 단독 조건),
        // so 2 independent sends (S0+S1) become 2*2=4 inbound deliveries with the same mid
        await waitFor(() => store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid).length >= 4);

        const receives = store.getSnapshot().events.filter(e => e.kind === 'receive' && e.direction === 'in' && e.meta?.mid);
        const duplicates = store.getSnapshot().events.filter(e => e.kind === 'duplicate');
        expect(receives).toHaveLength(1);
        expect(duplicates).toHaveLength(3);

        const mid = receives[0].meta?.mid;
        expect(mid).toBeTruthy();
        expect(duplicates.every(e => e.meta?.mid === mid)).toBe(true);
    });

    it('N=3 구성(Add Socket 2회)에서 sendAll 1회 = mid 수신 정확히 9건(receive 1 + duplicate 8), 소켓별 3건씩 고르게 분포한다', async () => {
        const m = attach();
        await addBackups(m, 2);

        m.sendAll({ hello: 'n3' });

        await waitFor(() => store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid).length >= 9);

        const midEvents = store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid);
        expect(midEvents).toHaveLength(9);
        expect(midEvents.filter(e => e.kind === 'receive')).toHaveLength(1);
        expect(midEvents.filter(e => e.kind === 'duplicate')).toHaveLength(8);

        // each of the 3 sockets independently sent once and every socket is broadcast to by the mock
        // server, so each socket's own tagged stream sees exactly 3 deliveries (1 echo + 2 relays)
        const byIndex = [0, 1, 2].map(index => midEvents.filter(e => e.meta?.socketIndex === index).length);
        expect(byIndex).toEqual([3, 3, 3]);
    });

    it('소켓 단독 send(S1)는 N건(에코 1 + 중계 N-1) 수신을 발생시키고 발신 이벤트에 해당 소켓 칩이 붙는다', async () => {
        const m = attach();
        await addBackups(m, 2); // N=3

        m.sendOne(1, { solo: true });

        const sendEvent = store.getSnapshot().events.find(e => e.kind === 'send' && e.meta?.socketIndex === 1);
        expect(sendEvent).toBeDefined();
        expect(sendEvent?.direction).toBe('out');
        const mid = sendEvent?.meta?.mid;

        await waitFor(() => store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid === mid).length >= 3);

        const midEvents = store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid === mid);
        expect(midEvents).toHaveLength(3); // echo to S1 itself + relay to S0 + relay to S2
    });

    it('Remove Socket 후 합성체가 재생성되어 남은 구성 기준으로 sendAll이 정상 동작한다', async () => {
        const m = attach();
        await addBackups(m, 2); // N=3: S0, S1, S2

        m.removeSocket(1); // remove S1 - S2 shifts down to become the new S1 (array-positional indexing)
        const afterRemove = store.getSnapshot().connections.find(c => c.id === 'A')?.sockets;
        expect(afterRemove).toHaveLength(2);
        expect(afterRemove?.map(s => s.index)).toEqual([0, 1]);

        m.sendAll({ after: 'remove' });
        const sendEvent = store.getSnapshot().events.filter(e => e.kind === 'send' && e.detail.startsWith('sendAll')).pop();
        const mid = sendEvent?.meta?.mid;

        // only 2 sockets remain configured, so sendAll now yields 2*2=4 deliveries for this mid (not 9)
        await waitFor(() => store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid === mid).length >= 4);
        const midEvents = store.getSnapshot().events.filter(e => (e.kind === 'receive' || e.kind === 'duplicate') && e.meta?.mid === mid);
        expect(midEvents).toHaveLength(4);

        // the survivor's direct-subscribe tagging must have moved with it to the new index (1), not
        // stayed pinned to its old one (2) - the exact split reported by review (row label vs receive chip)
        const byIndex = [0, 1].map(index => midEvents.filter(e => e.meta?.socketIndex === index).length);
        expect(byIndex).toEqual([2, 2]);
        expect(midEvents.some(e => e.meta?.socketIndex === 2)).toBe(false);
    });

    it('Sockets 활성 상태에서도 기존 transport 경유 대용량 send가 정상 재조립되고 mid 파생과 간섭하지 않는다', async () => {
        const m = attach();
        await addBackups(m, 1);

        const text = 'x'.repeat(40_000);
        await session.send({ text });

        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'assemble'));

        const chunkOuts = store.getSnapshot().events.filter(e => e.kind === 'chunk-out');
        expect(chunkOuts.length).toBeGreaterThan(1);

        // mid-only derivation must never fire for transport ("type":"json:) frames
        expect(store.getSnapshot().events.some(e => e.kind === 'duplicate')).toBe(false);
        expect(store.getSnapshot().events.some(e => e.meta?.mid)).toBe(false);
    });

    it('S0(메인)를 직접 닫으면 기존 Send(transport)도 함께 죽고 sendAll 실패는 socketIndex=0 에러로 변환되며 백업은 지속된다', async () => {
        const m = attach();
        await addBackups(m, 1);

        m.closeSocket(0);
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.status).toBe('closed');

        // honest display: the existing transport Send path is S0-only, so it now fails too (existing ws-session pipeline, unmodified)
        await expect(session.send({ after: 'main-close' })).resolves.toBeUndefined();
        expect(store.getSnapshot().events.some(e => e.kind === 'error' && e.meta?.scope === 'json.send')).toBe(true);

        m.sendAll({ after: 'main-close' });
        await waitFor(() =>
            store
                .getSnapshot()
                .events.some(e => e.kind === 'error' && e.severity === 'error' && e.meta?.scope === MULTI_NETWORK_SCOPE.send),
        );
        const failure = store.getSnapshot().events.find(e => e.kind === 'error' && e.meta?.scope === MULTI_NETWORK_SCOPE.send);
        expect(failure?.meta?.socketIndex).toBe(0);

        // S1 is the only connection left, so its own broadcast still comes back (no duplicate)
        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'receive' && e.direction === 'in' && e.meta?.mid));
    });

    it('백업(S1) 소켓만 닫아도 메인 단독 send/receive(transport 경유)는 계속 동작한다', async () => {
        const m = attach();
        await addBackups(m, 1);

        m.closeSocket(1);
        const sockets = store.getSnapshot().connections.find(c => c.id === 'A')?.sockets;
        expect(sockets?.find(s => s.index === 1)?.status).toBe('closed');
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.status).toBe('open');

        await session.send({ still: 'alive' });
        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'receive' && e.direction === 'in'));
    });

    it('레이스 회귀: addSocket 대기 중 detach()가 일어나면 반영되지 않고 소켓이 정리되며 이후 재시도도 정상 동작한다', async () => {
        const primary = session.getPrimaryNetwork();
        if (!primary) throw new Error('primary not connected');
        const stale = createMultiSession({ id: 'A', store, primary, mainUrl: url });

        // simulate ConnectionPanel's generation-mismatch discard: detach() (Close/Reconnect/unmount) races
        // an in-flight addSocket() - once the handshake resolves it must discard itself, not join
        const addPromise = stale.addSocket(url);
        stale.detach();
        await addPromise;

        const afterDiscard = store.getSnapshot().connections.find(c => c.id === 'A');
        expect(afterDiscard?.sockets).toBeUndefined();

        // a fresh session on the same (still-live) S0 must work cleanly afterward - no leak/lock-up from the discarded add
        multi = createMultiSession({ id: 'A', store, primary, mainUrl: url });
        await multi.addSocket(url);
        const sockets = store.getSnapshot().connections.find(c => c.id === 'A')?.sockets;
        expect(sockets).toHaveLength(2);
    });
});
