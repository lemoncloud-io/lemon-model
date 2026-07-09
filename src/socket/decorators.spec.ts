/**
 * `decorators.spec.ts`
 * - L1 decorator test: reconnect-on-death wrapper and raw wire translator, standalone (no L3/L4).
 * - the translated-wire + L3 composition proof lives in `sync/client.spec.ts` (sync may import socket, not vice versa).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, GETERR } from '../cores/index.spec';
import { createReconnectingNetwork, createTranslatedNetwork, WireTranslator } from './decorators';
import { createNetwork } from './testing';
import { NetworkSupportable, SocketReadyState } from './types';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** hand-driven network stub: readyState is controlled by the test (like a real WebSocket mid-handshake) */
const createManualNetwork = (initial: SocketReadyState = 'connecting') => {
    let state = initial;
    const openHandlers = new Set<() => void>();
    const stub = {
        get readyState() {
            return state;
        },
        onOpen: (handler: () => void) => {
            openHandlers.add(handler);
            return () => openHandlers.delete(handler);
        },
        send: (_data: string) => undefined as void,
        onMessage: (): (() => void) => () => undefined,
        onError: (): (() => void) => () => undefined,
        close: () => {
            state = 'closed';
        },
        /** test control: complete the handshake */
        open: () => {
            state = 'open';
            for (const handler of [...openHandlers]) handler();
        },
    };
    return stub as NetworkSupportable & { open: () => void };
};

describe('decorators', () => {
    describe('createReconnectingNetwork', () => {
        it('should swap generations after the internal network dies and notify onReconnect', async () => {
            const created: ReturnType<typeof createNetwork>[] = [];
            const factory = () => {
                const network = createNetwork();
                created.push(network);
                return network;
            };
            const reconnecting = createReconnectingNetwork(factory, { baseMs: 5, maxMs: 10, watchdogMs: 5 });
            expect2(() => reconnecting.generation).toEqual(0);

            let reconnectCount = 0;
            reconnecting.onReconnect(() => reconnectCount++);
            const received: string[] = [];
            reconnecting.onMessage(raw => received.push(raw));

            created[0].close(); // external death the decorator did not initiate; fires no event by itself
            await wait(60); // watchdog notices readyState + backoff(5ms) before the swap

            expect2(() => reconnecting.generation).toEqual(1);
            expect2(() => reconnectCount).toEqual(1);
            expect2(() => created.length).toEqual(2);

            // new generation is wired without re-subscribing: send()/onMessage() work through the same instance
            reconnecting.send(JSON.stringify({ hello: true }));
            await wait();
            expect2(() => received.length).toEqual(1);
            reconnecting.close(); // stop the watchdog so it doesn't outlive this test
        });

        it('should force a reconnect once idleTimeoutMs elapses with no inbound message', async () => {
            const created: ReturnType<typeof createNetwork>[] = [];
            const factory = () => {
                const network = createNetwork();
                created.push(network);
                return network;
            };
            const reconnecting = createReconnectingNetwork(factory, { baseMs: 5, idleTimeoutMs: 15, watchdogMs: 5 });

            await wait(50); // watchdog observes the idle gap and forces a reconnect even though nothing died

            expect2(() => reconnecting.generation >= 1).toEqual(true);
            reconnecting.close(); // stop the watchdog so it doesn't outlive this test
        });

        it('should throw a synchronous "not connected" from send() while disconnected', async () => {
            let network!: ReturnType<typeof createNetwork>;
            const factory = () => (network = createNetwork());
            const reconnecting = createReconnectingNetwork(factory, { baseMs: 1_000 }); // long backoff on purpose

            network.close(); // kill the only network before any reconnect can complete

            expect2(() => reconnecting.send('x')).toEqual('@network is not connected - reconnectingNetwork.send');
            reconnecting.close(); // stop the watchdog/pending reconnect timer so they don't outlive this test
        });

        it('should stop reconnecting after close() and never reconnect afterward', async () => {
            const created: ReturnType<typeof createNetwork>[] = [];
            const factory = () => {
                const network = createNetwork();
                created.push(network);
                return network;
            };
            const reconnecting = createReconnectingNetwork(factory, { baseMs: 5 });

            reconnecting.close();
            expect2(() => reconnecting.readyState).toEqual('closed');
            expect2(() => reconnecting.send('x')).toEqual('@network is closed - reconnectingNetwork.send');

            await wait(40);
            expect2(() => reconnecting.generation).toEqual(0);
            expect2(() => created.length).toEqual(1);
        });

        it('should settle a reconnect (and fire onReconnect) only once the candidate actually opens', async () => {
            const candidates: ReturnType<typeof createManualNetwork>[] = [];
            let gen0!: ReturnType<typeof createNetwork>;
            const factory = (): NetworkSupportable => {
                if (!gen0) return (gen0 = createNetwork()); // 최초 연결: in-memory라 즉시 open
                const candidate = createManualNetwork('connecting');
                candidates.push(candidate);
                return candidate;
            };
            const reconnecting = createReconnectingNetwork(factory, { baseMs: 5, maxMs: 10, watchdogMs: 5 });
            let reconnects = 0;
            reconnecting.onReconnect(() => reconnects++);

            gen0.close();
            await wait(40); // 후보가 만들어졌지만 아직 open 전 — 성공으로 치지 않는다

            expect2(() => candidates.length >= 1).toEqual(true);
            expect2(() => reconnecting.generation).toEqual(0);
            expect2(() => reconnects).toEqual(0);

            candidates[candidates.length - 1].open(); // handshake 완료 시점에만 정착
            await wait(10);

            expect2(() => reconnecting.generation).toEqual(1);
            expect2(() => reconnects).toEqual(1);
            reconnecting.close();
        });

        it('should count candidates that die before opening as failed retries (backoff is not reset)', async () => {
            let gen0!: ReturnType<typeof createNetwork>;
            const factory = (): NetworkSupportable => {
                if (!gen0) return (gen0 = createNetwork());
                return createManualNetwork('closed'); // 서버 다운: 후보가 open 전에 죽어 있음
            };
            const reconnecting = createReconnectingNetwork(factory, {
                baseMs: 2,
                maxMs: 4,
                maxRetries: 2,
                watchdogMs: 5,
            });
            const errors: string[] = [];
            let reconnects = 0;
            reconnecting.onError(error => errors.push(GETERR(error)));
            reconnecting.onReconnect(() => reconnects++);

            gen0.close();
            await wait(60);

            expect2(() => reconnecting.readyState).toEqual('closed'); // maxRetries 소진 → 영구 종료
            expect2(() => reconnects).toEqual(0); // open된 적이 없으니 onReconnect도 없다
            expect2(() => errors.some(message => message.includes('died before open'))).toEqual(true);
            expect2(() => errors.some(message => message.includes('maxRetries'))).toEqual(true);
        });

        it('should permanently close and notify onError once maxRetries reconnect attempts are exhausted', async () => {
            const created: ReturnType<typeof createNetwork>[] = [];
            let calls = 0;
            const factory = () => {
                calls++;
                if (calls === 1) {
                    const network = createNetwork();
                    created.push(network);
                    return network;
                }
                throw new Error(`boom-${calls}`); // every reconnect attempt after the initial connect fails
            };
            const reconnecting = createReconnectingNetwork(factory, {
                baseMs: 2,
                maxMs: 4,
                maxRetries: 2,
                watchdogMs: 5,
            });
            const errors: string[] = [];
            reconnecting.onError(error => errors.push(GETERR(error)));

            created[0].close();
            await wait(60);

            expect2(() => reconnecting.readyState).toEqual('closed');
            expect2(() => reconnecting.generation).toEqual(0);
            expect2(() => errors.some(message => message.includes('maxRetries'))).toEqual(true);
        });
    });

    describe('createTranslatedNetwork', () => {
        //! example codec only - chatic-specific `:ok`/`:error` suffix rewrite rules stay OUT of lemon-model itself.
        const chaticCodec: WireTranslator = {
            inbound: (raw: string): string | undefined => {
                let parsed: any;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    return raw;
                }
                if (typeof parsed?.type !== 'string') return raw;
                if (parsed.type.endsWith(':ok')) return JSON.stringify({ ...parsed, type: 'result' });
                if (parsed.type.endsWith(':error')) return JSON.stringify({ ...parsed, type: 'error' });
                return raw;
            },
        };

        it('should rewrite legacy :ok/:error suffix envelopes at the raw boundary (example codec)', async () => {
            const bus = createNetwork();
            const translated = createTranslatedNetwork(bus, chaticCodec);
            const received: string[] = [];
            translated.onMessage(raw => received.push(JSON.parse(raw).type));

            bus.send(JSON.stringify({ type: 'x.y:ok', data: { ok: true }, mid: 'm1' }));
            bus.send(JSON.stringify({ type: 'x.y:error', data: { code: 'BOOM' }, mid: 'm2' }));
            await wait();

            //! in-memory delivery is unordered by default; assert the convergent set, not arrival order.
            expect2(() => [...received].sort()).toEqual(['error', 'result']);
        });

        it('should drop raw the inbound translator marks as undefined', async () => {
            const bus = createNetwork();
            const dropper: WireTranslator = { inbound: raw => (raw.includes('drop-me') ? undefined : raw) };
            const translated = createTranslatedNetwork(bus, dropper);
            const received: string[] = [];
            translated.onMessage(raw => received.push(JSON.parse(raw).mid));

            bus.send(JSON.stringify({ type: 'keep', data: {}, mid: 'm1', tag: 'drop-me' }));
            bus.send(JSON.stringify({ type: 'keep', data: {}, mid: 'm2' }));
            await wait();

            expect2(() => received).toEqual(['m2']);
        });

        it('should drop raw and emit onError when the inbound translator throws', async () => {
            const bus = createNetwork();
            const boomTranslator: WireTranslator = {
                inbound: raw => {
                    if (raw.includes('boom')) throw new Error('translator boom');
                    return raw;
                },
            };
            const translated = createTranslatedNetwork(bus, boomTranslator);
            const received: string[] = [];
            const errors: string[] = [];
            translated.onMessage(raw => received.push(raw));
            translated.onError(error => errors.push(GETERR(error)));

            bus.send(JSON.stringify({ type: 'x', data: {}, mid: 'boom-mid' }));
            await wait();

            expect2(() => received).toEqual([]);
            expect2(() => errors).toEqual(['translator boom']);
        });
    });
});
