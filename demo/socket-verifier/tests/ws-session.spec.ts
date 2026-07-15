import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import { startMockServer } from '../mock-server.mjs';
import { createWsSession } from '../src/ws-session';
import { createVerifierStore, type VerifierStore } from '../src/verifier-store';
import { DEFAULT_VERIFIER_CONDITION, type ConnectionState, type VerifierSession } from '../src/types';

/** node has no global WebSocket in this runtime target; inject the `ws` package (03-plan risk note) */
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

describe('ws-session', () => {
    let wss: ReturnType<typeof startMockServer>;
    let url: string;
    let store: VerifierStore;
    let sessions: VerifierSession[];

    beforeEach(async () => {
        wss = startMockServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => wss.once('listening', () => resolve()));
        const address = wss.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        url = `ws://127.0.0.1:${port}`;
        store = createVerifierStore();
        sessions = [];
    });

    afterEach(async () => {
        sessions.forEach(session => session.close());
        await new Promise<void>(resolve => wss.close(() => resolve()));
    });

    const connectSession = async (id: string, options?: Parameters<typeof createWsSession>[0]['transportOptions']) => {
        store.addConnection(initialConnection(id));
        const session = createWsSession({ id, url, store, transportOptions: options });
        sessions.push(session);
        await session.connect();
        return session;
    };

    it('connect 시 handshake 이벤트와 remoteConnectionId를 획득한다', async () => {
        await connectSession('A');

        const handshake = store.getSnapshot().events.find(e => e.kind === 'handshake');
        expect(handshake).toBeDefined();
        expect(handshake?.direction).toBe('in');
        expect(handshake?.meta?.remoteConnectionId).toMatch(/^conn-[0-9a-z]+-\d+$/);
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.remoteConnectionId).toBe(
            handshake?.meta?.remoteConnectionId,
        );
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.status).toBe('open');
    });

    it('큰 payload 전송 시 chunk-out 다수 발생 후 에코가 재조립되어 receive된다', async () => {
        const session = await connectSession('A');

        const text = 'x'.repeat(40_000);
        await session.send({ text });

        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'assemble' && e.connectionId === 'A'));

        const chunkOuts = store.getSnapshot().events.filter(e => e.kind === 'chunk-out');
        expect(chunkOuts.length).toBeGreaterThan(1);

        const received = store.getSnapshot().events.some(e => e.kind === 'receive' && e.direction === 'in');
        expect(received).toBe(true);

        const assembleEvent = store.getSnapshot().events.find(e => e.kind === 'assemble' && e.connectionId === 'A');
        expect(typeof assembleEvent?.meta?.elapsedMs).toBe('number');
        expect(assembleEvent?.meta?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(assembleEvent?.detail).toMatch(/\(\+\d+ms\)$/);
    });

    it('dropRate 주입으로 일부 패킷이 유실되면 pending 후 (축소 TTL 만료로) expired 이벤트가 발생한다', async () => {
        const session = await connectSession('A', { cleanupIntervalMs: 30, partialTtlMs: 80 });

        session.configure({ ...DEFAULT_VERIFIER_CONDITION, dropRate: 0.5 });

        // manifest passes (0.9 >= dropRate), complete is dropped (0.1 < dropRate) — leaves the message pending forever
        const randomSpy = vi.spyOn(Math, 'random');
        randomSpy.mockReturnValueOnce(0.9).mockReturnValueOnce(0.1);
        await session.send({ hello: 'world' });
        randomSpy.mockRestore();

        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'pending' && e.connectionId === 'A'));
        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'expired' && e.connectionId === 'A'));

        const expired = store.getSnapshot().events.find(e => e.kind === 'expired');
        expect(expired?.severity).toBe('error');
        expect(expired?.meta?.scope).toBe('json.partial.expired');
    });

    it('corruptRate=1이면 수신측 json.chunk.hash가 error 이벤트로 표면화된다', async () => {
        const session = await connectSession('A');
        session.configure({ ...DEFAULT_VERIFIER_CONDITION, corruptRate: 1 });

        await session.send({ text: 'y'.repeat(40_000) });

        await waitFor(() =>
            store
                .getSnapshot()
                .events.some(e => e.kind === 'error' && e.severity === 'error' && e.meta?.scope === 'json.chunk.hash'),
        );

        const corruptTap = store.getSnapshot().events.find(e => e.kind === 'corrupt');
        expect(corruptTap).toBeDefined();
    });

    it('close/reconnect 이벤트가 발생하고 재연결 후 send가 정상 동작한다', async () => {
        const session = await connectSession('A');

        session.close();
        expect(store.getSnapshot().events.some(e => e.kind === 'close' && e.connectionId === 'A')).toBe(true);
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.status).toBe('closed');

        await session.reconnect();
        expect(store.getSnapshot().events.some(e => e.kind === 'reconnect' && e.connectionId === 'A')).toBe(true);
        expect(store.getSnapshot().connections.find(c => c.id === 'A')?.status).toBe('open');

        await session.send({ text: 'after-reconnect' });
        await waitFor(() =>
            store
                .getSnapshot()
                .events.some(e => e.kind === 'receive' && e.direction === 'in' && e.connectionId === 'A'),
        );
    });

    it('connectionId 응답 프레임이 json.packet 에러를 만들지 않는다 (FilteredNetwork 회귀 가드)', async () => {
        const session = await connectSession('A');
        await session.send({ text: 'plain' });

        await waitFor(() => store.getSnapshot().events.some(e => e.kind === 'receive' && e.direction === 'in'));

        const packetErrors = store
            .getSnapshot()
            .events.filter(e => e.kind === 'error' && e.meta?.scope === 'json.packet');
        expect(packetErrors).toHaveLength(0);
    });

    it('1009 too-big 전송 실패 시 json.send 에러 이벤트가 정확히 1개만 발생하고 send는 정상 resolve된다', async () => {
        const session = await connectSession('A');
        session.configure({ ...DEFAULT_VERIFIER_CONDITION, maxPacketBytes: 10 });

        await expect(session.send({ text: 'x'.repeat(1000) })).resolves.toBeUndefined();

        const sendErrors = store.getSnapshot().events.filter(e => e.kind === 'error' && e.meta?.scope === 'json.send');
        expect(sendErrors).toHaveLength(1);
    });
});
