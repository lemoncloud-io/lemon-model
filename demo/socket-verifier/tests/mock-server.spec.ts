import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startMockServer } from '../mock-server.mjs';

const waitOpen = (ws: WebSocket) => new Promise<void>(resolve => ws.once('open', () => resolve()));

const waitMessage = (ws: WebSocket, timeoutMs = 500) =>
    new Promise<string | null>(resolve => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        ws.once('message', data => {
            clearTimeout(timer);
            resolve(data.toString());
        });
    });

describe('mock-server', () => {
    let wss: ReturnType<typeof startMockServer>;
    let url: string;

    beforeEach(async () => {
        wss = startMockServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>(resolve => wss.once('listening', () => resolve()));
        const address = wss.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        url = `ws://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        await new Promise<void>(resolve => wss.close(() => resolve()));
    });

    it('connect 프레임에 connectionId로 응답한다', async () => {
        const ws = new WebSocket(url);
        await waitOpen(ws);

        ws.send(JSON.stringify({ action: 'connect' }));
        const reply = await waitMessage(ws);
        expect(reply).not.toBeNull();
        const parsed = JSON.parse(reply as string);
        expect(parsed.connectionId).toMatch(/^conn-[0-9a-z]+-\d+$/);

        ws.close();
    });

    it('텍스트 프레임을 발신자에 에코한다', async () => {
        const ws = new WebSocket(url);
        await waitOpen(ws);

        ws.send('hello');
        const reply = await waitMessage(ws);
        expect(reply).toBe('hello');

        ws.close();
    });

    it('텍스트 프레임을 다른 연결에도 중계한다', async () => {
        const a = new WebSocket(url);
        const b = new WebSocket(url);
        await Promise.all([waitOpen(a), waitOpen(b)]);

        const bMessage = waitMessage(b);
        a.send('relay-me');
        expect(await bMessage).toBe('relay-me');

        a.close();
        b.close();
    });

    it('connect 프레임은 에코·중계되지 않는다', async () => {
        const a = new WebSocket(url);
        const b = new WebSocket(url);
        await Promise.all([waitOpen(a), waitOpen(b)]);

        const bMessage = waitMessage(b, 300);
        const aReply = waitMessage(a, 300);
        a.send(JSON.stringify({ action: 'connect' }));

        expect(await bMessage).toBeNull();
        const aReplyText = await aReply;
        expect(aReplyText).not.toBeNull();
        expect(JSON.parse(aReplyText as string).connectionId).toBeDefined();

        a.close();
        b.close();
    });

    it('바이너리 프레임은 조용히 무시한다', async () => {
        const ws = new WebSocket(url);
        await waitOpen(ws);

        ws.send(Buffer.from([1, 2, 3]));
        const reply = await waitMessage(ws, 300);
        expect(reply).toBeNull();

        ws.close();
    });
});
