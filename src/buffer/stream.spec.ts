import { expect2 } from '../cores/index.spec';
import {
    asLegacyTokenConsumer,
    asStreamConsumer,
    estimateGenAIStreamSize,
    GenAIStreamBuffer,
    GenAIStreamEvent,
    mockGenAIStream,
    runMockGenAIStream,
} from './stream';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('GenAIStreamBuffer', () => {
    it('flushes chunks in FIFO order by buffer size', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'size',
                bufferSize: 3,
                meta: { provider: 'test', model: 'mock' },
            },
        );

        await buffer.write('a');
        await buffer.write('b');
        expect2(() => events.length).toEqual(0);

        await buffer.write('c');
        expect2(() => events.length).toEqual(1);
        expect2(() => events[0].type).toEqual('flush');
        expect2(() => (events[0] as any).data).toEqual('abc');
        expect2(() => (events[0] as any).chunks.map((chunk: any) => chunk.data)).toEqual(['a', 'b', 'c']);
    });

    it('flushes remaining chunks and emits eof on close', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            { bufferSize: 10 },
        );

        await buffer.write('left');
        await buffer.close();

        expect2(() => events.map(event => event.type)).toEqual(['flush', 'eof']);
        expect2(() => (events[0] as any).data).toEqual('left');
        expect2(() => (events[1] as any).progress.percent).toEqual(100);
    });

    it('flushes by max wait time when size threshold is not reached', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'hybrid',
                bufferSize: 10,
                maxWaitMs: 20,
            },
        );

        await buffer.write('soon');
        await wait(35);

        expect2(() => events.length).toEqual(1);
        expect2(() => events[0].type).toEqual('flush');
        expect2(() => (events[0] as any).data).toEqual('soon');
        await buffer.close();
    });

    it('flushes time strategy by bufferMs while ignoring size and byte thresholds', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'time',
                bufferSize: 1,
                bufferBytes: 1,
                bufferMs: 40,
                maxWaitMs: 1,
            },
        );

        await buffer.write('abc');
        await buffer.write('def');
        await wait(15);

        expect2(() => events.length).toEqual(0);

        await wait(35);

        expect2(() => events.length).toEqual(1);
        expect2(() => events[0].type).toEqual('flush');
        expect2(() => (events[0] as any).data).toEqual('abcdef');
        await buffer.close();
    });

    it('calculates progress from explicit estimates', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                useBuffer: false,
                meta: { estimate: { totalChars: 10, estimated: false, source: 'test' } },
                emitProgress: true,
            },
        );

        await buffer.write('12345');

        const progress = events.find(event => event.type === 'progress') as any;
        const flush = events.find(event => event.type === 'flush') as any;
        expect2(() => progress.progress.percent).toEqual(50);
        expect2(() => progress.progress.bufferPercent).toEqual(99);
        expect2(() => flush.progress.percent).toEqual(50);
        expect2(() => flush.progress.bufferPercent).toEqual(100);
    });

    it('tracks progress while chunks are still buffered before flush', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'size',
                bufferSize: 3,
                emitProgress: true,
                meta: {
                    provider: 'test',
                    model: 'progress-model',
                    estimate: { totalChars: 12, estimated: false, source: 'test' },
                },
            },
        );

        await buffer.write('ab');
        await buffer.write('cde');

        const pending = buffer.snapshot();
        expect2(() => pending.pendingChunks).toEqual(2);
        expect2(() => pending.pendingChars).toEqual(5);
        expect2(() => pending.loadedChars).toEqual(5);
        expect2(() => pending.progress.percent).toEqual(41);
        expect2(() => pending.progress.bufferPercent).toEqual(66);
        expect2(() => events.map(event => event.type)).toEqual(['progress', 'progress']);
        expect2(() => events.map((event: any) => event.progress.percent)).toEqual([16, 41]);
        expect2(() => events.map((event: any) => event.progress.bufferPercent)).toEqual([33, 66]);

        await buffer.write('f');

        const progressEvents = events.filter(event => event.type === 'progress') as any[];
        const flush = events.find(event => event.type === 'flush') as any;
        expect2(() => progressEvents.map(event => event.progress.percent)).toEqual([16, 41, 50]);
        expect2(() => progressEvents.map(event => event.progress.bufferPercent)).toEqual([33, 66, 99]);
        expect2(() => flush.data).toEqual('abcdef');
        expect2(() => flush.progress.percent).toEqual(50);
        expect2(() => flush.progress.bufferPercent).toEqual(100);
        expect2(() => flush.progress.source).toEqual('flush');
        expect2(() => flush.progress.pendingChunks).toEqual(3);
        expect2(() => flush.progress.pendingChars).toEqual(6);
        expect2(() => flush.chunks.map((chunk: any) => chunk.progress.percent)).toEqual([16, 41, 50]);
        expect2(() => flush.chunks.map((chunk: any) => chunk.progress.bufferPercent)).toEqual([33, 66, 99]);
        expect2(() => buffer.snapshot().pendingChunks).toEqual(0);
    });

    it('calculates byte-based progress and flushes by byte threshold', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'bytes',
                bufferBytes: 5,
                meta: {
                    estimate: { totalBytes: 12, estimated: false, source: 'byte-test' },
                },
            },
        );

        await buffer.write('가');
        expect2(() => buffer.snapshot().pendingBytes).toEqual(3);
        expect2(() => buffer.snapshot().progress.percent).toEqual(25);
        expect2(() => buffer.snapshot().progress.bufferPercent).toEqual(60);
        expect2(() => events.length).toEqual(0);

        await buffer.write('나');

        const flush = events[0] as any;
        expect2(() => flush.type).toEqual('flush');
        expect2(() => flush.data).toEqual('가나');
        expect2(() => flush.bytes).toEqual(6);
        expect2(() => flush.progress.loadedBytes).toEqual(6);
        expect2(() => flush.progress.percent).toEqual(50);
        expect2(() => flush.progress.bufferPercent).toEqual(100);
    });

    it('uses token progress when char and byte totals are unavailable', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'size',
                bufferSize: 10,
                emitProgress: true,
                meta: {
                    estimate: { totalTokens: 10, estimated: true, source: 'token-test' },
                },
            },
        );

        await buffer.write('hello', { tokens: 2 });
        await buffer.write(' world', { tokens: 3 });
        await buffer.close();

        const progressEvents = events.filter(event => event.type === 'progress') as any[];
        const flush = events.find(event => event.type === 'flush') as any;
        const eof = events.find(event => event.type === 'eof') as any;
        expect2(() => progressEvents.map(event => event.progress.percent)).toEqual([20, 50]);
        expect2(() => progressEvents.map(event => event.progress.bufferPercent)).toEqual([10, 20]);
        expect2(() => progressEvents.map(event => event.progress.loadedTokens)).toEqual([2, 5]);
        expect2(() => flush.data).toEqual('hello world');
        expect2(() => flush.progress.percent).toEqual(50);
        expect2(() => flush.progress.bufferPercent).toEqual(100);
        expect2(() => eof.progress.percent).toEqual(100);
    });

    it('emits interval progress while chunks are pending', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'time',
                bufferMs: 100,
                progressIntervalMs: 20,
            },
        );

        await buffer.write('tick');
        await wait(50);

        const progressEvents = events.filter(event => event.type === 'progress') as any[];
        expect2(() => progressEvents.length > 0).toEqual(true);
        expect2(() => progressEvents.every(event => event.progress.source === 'interval')).toEqual(true);
        expect2(() =>
            progressEvents.some(event => event.progress.bufferPercent > 0 && event.progress.bufferPercent < 100),
        ).toEqual(true);

        await buffer.close();
    });

    it('reports cancel errors with reason and closes the buffer', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(event => {
            events.push(event);
        });

        await buffer.write('pending');
        await buffer.cancel({ code: 'USER_ABORT', message: 'user stopped stream' });

        const error = events.find(event => event.type === 'error') as any;
        expect2(() => error.error).toEqual({
            code: 'USER_ABORT',
            message: 'user stopped stream',
            reason: 'cancel',
        });
        expect2(() => buffer.snapshot().closed).toEqual(true);
        await expect(buffer.write('after-cancel')).rejects.toThrow('GenAIStreamBuffer is already closed');
    });

    it('reports timeout errors with reason and closes the buffer', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(
            event => {
                events.push(event);
            },
            {
                flushStrategy: 'time',
                bufferMs: 100,
                timeoutMs: 20,
            },
        );

        await buffer.write('pending');
        await wait(35);

        const error = events.find(event => event.type === 'error') as any;
        expect2(() => error.error.code).toEqual('GENAI_STREAM_BUFFER_TIMEOUT');
        expect2(() => error.error.reason).toEqual('timeout');
        expect2(() => error.error.timeoutMs).toEqual(20);
        expect2(() => events.map(event => event.type)).toEqual(['error']);
        expect2(() => buffer.snapshot().closed).toEqual(true);
    });

    it('reports upstream error events with reason and closes the buffer', async () => {
        const events: GenAIStreamEvent[] = [];
        const buffer = new GenAIStreamBuffer(event => {
            events.push(event);
        });

        await buffer.push({ type: 'error', error: new Error('provider failed') });

        const error = events.find(event => event.type === 'error') as any;
        expect2(() => error.error.name).toEqual('Error');
        expect2(() => error.error.message).toEqual('provider failed');
        expect2(() => error.error.reason).toEqual('upstream-error');
        expect2(() => buffer.snapshot().closed).toEqual(true);
    });

    it('delivers buffered flushes to the next consumer in order', async () => {
        const delivered: Array<{ type: string; data?: string; percent?: number; bufferPercent?: number }> = [];
        const buffer = new GenAIStreamBuffer(
            async event => {
                await wait(1);
                delivered.push({
                    type: event.type,
                    data: event.type === 'flush' ? event.data : undefined,
                    percent: 'progress' in event ? event.progress?.percent : undefined,
                    bufferPercent: 'progress' in event ? event.progress?.bufferPercent : undefined,
                });
            },
            {
                flushStrategy: 'size',
                bufferSize: 2,
                meta: { estimate: { totalChars: 6, estimated: false, source: 'delivery-test' } },
            },
        );

        await buffer.start();
        await buffer.write('a');
        expect2(() => delivered.map(event => event.type)).toEqual(['start']);

        await buffer.write('b');
        await buffer.write('c');
        expect2(() => delivered.map(event => event.type)).toEqual(['start', 'flush']);
        expect2(() => delivered[1]).toEqual({ type: 'flush', data: 'ab', percent: 33, bufferPercent: 100 });

        await buffer.close();
        expect2(() => delivered).toEqual([
            { type: 'start', data: undefined, percent: undefined, bufferPercent: undefined },
            { type: 'flush', data: 'ab', percent: 33, bufferPercent: 100 },
            { type: 'flush', data: 'c', percent: 50, bufferPercent: 100 },
            { type: 'eof', data: undefined, percent: 100, bufferPercent: 100 },
        ]);
    });

    it('flushes chunks queued while an async consumer is processing a previous flush', async () => {
        const delivered: string[] = [];
        let releaseFirstFlush: (() => void) | undefined;
        const firstFlushBlocked = new Promise<void>(resolve => {
            releaseFirstFlush = resolve;
        });
        const buffer = new GenAIStreamBuffer(
            async event => {
                if (event.type !== 'flush') return;
                delivered.push(event.data);
                if (event.data === 'a') await firstFlushBlocked;
            },
            {
                flushStrategy: 'size',
                bufferSize: 1,
            },
        );

        const firstWrite = buffer.write('a');
        await wait(5);
        await buffer.write('b');

        expect2(() => delivered).toEqual(['a']);
        expect2(() => buffer.snapshot().pendingChunks).toEqual(1);

        releaseFirstFlush?.();
        await firstWrite;
        await wait(5);

        expect2(() => delivered).toEqual(['a', 'b']);
        expect2(() => buffer.snapshot().pendingChunks).toEqual(0);
        await buffer.close();
    });

    it('estimates text and image output sizes from hints', () => {
        expect2(() => estimateGenAIStreamSize({ maxOutputTokens: 25 })).toEqual({
            totalChars: 100,
            totalBytes: 100,
            totalTokens: 25,
            estimated: true,
            source: 'maxOutputTokens',
            confidence: 0.45,
        });

        const image = estimateGenAIStreamSize({ kind: 'image', imageSize: '2k', imageFormat: 'webp' });
        expect2(() => image?.totalBytes).toEqual(1_050_000);
        expect2(() => image?.estimated).toEqual(true);
    });

    it('runs mock stream through the buffer', async () => {
        const events: GenAIStreamEvent[] = [];
        const snapshot = await runMockGenAIStream(
            'hello world',
            event => {
                events.push(event);
            },
            { flushStrategy: 'size', bufferSize: 2 },
            { chunkSize: 5, provider: 'mock-provider', model: 'mock-model' },
        );

        expect2(() => events.map(event => event.type)).toEqual(['start', 'flush', 'flush', 'eof']);
        expect2(() => events.filter(event => event.type === 'flush').map((event: any) => event.data)).toEqual([
            'hello worl',
            'd',
        ]);
        expect2(() => snapshot.closed).toEqual(true);
        expect2(() => snapshot.loadedChars).toEqual(11);
    });

    it('creates provider-like mock stream events', async () => {
        const events: GenAIStreamEvent[] = [];
        for await (const event of mockGenAIStream('abcd', { chunkSize: 2 })) {
            events.push(event);
        }

        expect2(() => events.map(event => event.type)).toEqual(['start', 'chunk', 'chunk', 'eof']);
        expect2(() => (events[1] as any).data).toEqual('ab');
        expect2(() => (events[2] as any).data).toEqual('cd');
    });

    it('adapts between legacy token consumer and stream consumer', async () => {
        const streamEvents: GenAIStreamEvent[] = [];
        const legacy = asLegacyTokenConsumer(event => {
            streamEvents.push(event);
        });
        await legacy('a');
        await legacy('b');
        await legacy(null);

        expect2(() => streamEvents.map(event => event.type)).toEqual(['flush', 'flush', 'eof']);

        const tokens: any[] = [];
        const stream = asStreamConsumer(token => {
            tokens.push(token);
        });
        await stream({ type: 'flush', data: 'ab', chunks: [], count: 0, chars: 2, bytes: 2, progress: null as any });
        await stream({ type: 'eof', progress: null as any });
        expect2(() => tokens).toEqual(['ab', null]);
    });
});
