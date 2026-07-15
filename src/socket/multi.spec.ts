/**
 * `socket/multi.spec.ts`
 * - contract regression guard for `MultiSocketNetwork`.
 * - uses a minimal deterministic fake network (no in-memory `Network` / delay-based delivery).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    NetworkMessageHandler,
    NetworkSupportable,
    SocketErrorContext,
    SocketErrorHandler,
    SocketNetworkOptions,
    SocketReadyState,
} from './types';
import { createMultiSocketNetwork, MULTI_NETWORK_SCOPE, MultiSocketErrorContext } from './multi';

/** deterministic fake `NetworkSupportable` for contract tests; no async delivery, no in-memory `Network`. */
class FakeNetwork implements NetworkSupportable {
    public readyState: SocketReadyState = 'open';
    public readonly sent: string[] = [];
    public readonly configured: SocketNetworkOptions[] = [];
    private readonly messageHandlers = new Set<NetworkMessageHandler>();
    private readonly errorHandlers = new Set<SocketErrorHandler>();

    public constructor(private readonly supportsOptional: boolean = true) {}

    public get onOpen(): ((handler: () => void) => () => void) | undefined {
        if (!this.supportsOptional) return undefined;
        return (handler: () => void) => {
            if (this.readyState === 'open') handler();
            return () => undefined;
        };
    }

    public get ready(): (() => Promise<void>) | undefined {
        if (!this.supportsOptional) return undefined;
        return () => (this.readyState === 'open' ? Promise.resolve() : Promise.reject(new Error('not open')));
    }

    public send(data: string): void {
        if (this.readyState !== 'open') throw new Error(`@network connection error: ${this.readyState} - fake.send`);
        this.sent.push(data);
    }

    public onMessage(handler: NetworkMessageHandler): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    public configure(options: SocketNetworkOptions): void {
        this.configured.push(options);
    }

    public onError(handler: SocketErrorHandler): () => void {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    }

    public close(): void {
        this.readyState = 'closed';
    }

    /** test helper: simulate an inbound frame regardless of readyState */
    public emitMessage(data: string): void {
        for (const handler of [...this.messageHandlers]) handler(data);
    }

    /** test helper: simulate an async delivery/lifecycle error */
    public emitError(error: any, context: SocketErrorContext): void {
        for (const handler of [...this.errorHandlers]) handler(error, context);
    }
}

describe('MultiSocketNetwork', () => {
    it('send() delegates to the main socket (index 0) only', () => {
        const [main, backup] = [new FakeNetwork(), new FakeNetwork()];
        const multi = createMultiSocketNetwork([main, backup]);

        multi.send('hello');

        expect(main.sent).toEqual(['hello']);
        expect(backup.sent).toEqual([]);
    });

    it('sendAll() sends the identical byte string to every socket', () => {
        const [main, backup] = [new FakeNetwork(), new FakeNetwork()];
        const multi = createMultiSocketNetwork([main, backup]);

        multi.sendAll('{"mid":"m-1"}');

        expect(main.sent).toEqual(['{"mid":"m-1"}']);
        expect(backup.sent).toEqual(['{"mid":"m-1"}']);
    });

    it('sendAll() never throws; a dead socket fails independently and emits network.multi.send with index', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        backup.close(); // backup is dead before the call
        const multi = createMultiSocketNetwork([main, backup]);

        const errors: [any, MultiSocketErrorContext][] = [];
        multi.onError((error, context) => errors.push([error, context as MultiSocketErrorContext]));

        expect(() => multi.sendAll('payload')).not.toThrow();
        expect(main.sent).toEqual(['payload']); // live socket still sends
        expect(backup.sent).toEqual([]);

        expect(errors).toHaveLength(1);
        expect(errors[0][1].scope).toBe(MULTI_NETWORK_SCOPE.send);
        expect(errors[0][1].index).toBe(1);
        expect(errors[0][1].network).toBe(multi);
    });

    it('a throwing onError handler cannot break sendAll(): call does not throw, the other socket still sends, and a well-behaved handler still sees both failures', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        main.close();
        backup.close();
        const multi = createMultiSocketNetwork([main, backup]);

        const seenByGoodHandler: MultiSocketErrorContext[] = [];
        multi.onError(() => {
            throw new Error('consumer handler bug');
        });
        multi.onError((_error, context) => seenByGoodHandler.push(context as MultiSocketErrorContext));

        expect(() => multi.sendAll('payload')).not.toThrow();
        expect(seenByGoodHandler).toHaveLength(2);
        expect(seenByGoodHandler.map(c => c.index).sort()).toEqual([0, 1]);
    });

    it('onMessage() merges inbound from every socket into one stream', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const received: string[] = [];
        multi.onMessage(data => received.push(data));

        main.emitMessage('from-main');
        backup.emitMessage('from-backup');

        expect(received).toEqual(['from-main', 'from-backup']);
    });

    it('onMessage() unsubscribe stops delivery from every socket', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const received: string[] = [];
        const unsubscribe = multi.onMessage(data => received.push(data));
        unsubscribe();

        main.emitMessage('after-unsubscribe-main');
        backup.emitMessage('after-unsubscribe-backup');

        expect(received).toEqual([]);
    });

    it('onError() tags index at subscription time and unifies context.network to the composite', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const seen: MultiSocketErrorContext[] = [];
        multi.onError((_error, context) => seen.push(context as MultiSocketErrorContext));

        main.emitError(new Error('m'), { scope: 'ownedWebSocket.close', network: main });
        backup.emitError(new Error('b'), { scope: 'ownedWebSocket.close', network: backup });

        expect(seen).toHaveLength(2);
        expect(seen[0].index).toBe(0);
        expect(seen[0].network).toBe(multi);
        expect(seen[1].index).toBe(1);
        expect(seen[1].network).toBe(multi);
    });

    it('onError() unsubscribe stops both the delegated (per-socket) and local-emit (sendAll failure) paths', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        main.close();
        backup.close();
        const multi = createMultiSocketNetwork([main, backup]);

        const seen: MultiSocketErrorContext[] = [];
        const unsubscribe = multi.onError((_error, context) => seen.push(context as MultiSocketErrorContext));
        unsubscribe();

        main.emitError(new Error('m'), { scope: 'ownedWebSocket.close', network: main });
        backup.emitError(new Error('b'), { scope: 'ownedWebSocket.close', network: backup });
        multi.sendAll('too-late'); // local-emit path; both sockets are closed

        expect(seen).toEqual([]);
    });

    it('isolates the main socket from a backup: main close does not stop backup receive/send, and readyState=closed does not stop receive', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const received: string[] = [];
        multi.onMessage(data => received.push(data));

        main.close(); // direct close, bypassing the composite
        expect(main.readyState).toBe('closed');

        // backup keeps receiving
        backup.emitMessage('still-alive');
        expect(received).toEqual(['still-alive']);

        // sendAll: dead main fails, live backup still sends
        expect(() => multi.sendAll('after-close')).not.toThrow();
        expect(backup.sent).toEqual(['after-close']);

        // readyState closed does not gate onMessage delivery
        main.emitMessage('closed-but-still-received');
        expect(received).toEqual(['still-alive', 'closed-but-still-received']);
    });

    it('close() is idempotent, closes every socket, and post-close sendAll failures stay observable (subscription kept)', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const errors: MultiSocketErrorContext[] = [];
        multi.onError((_error, context) => errors.push(context as MultiSocketErrorContext));

        multi.close();
        expect(main.readyState).toBe('closed');
        expect(backup.readyState).toBe('closed');

        expect(() => multi.close()).not.toThrow(); // idempotent

        multi.sendAll('too-late');
        expect(errors).toHaveLength(2);
        expect(errors.map(e => e.index).sort()).toEqual([0, 1]);
        expect(errors.every(e => e.scope === MULTI_NETWORK_SCOPE.send)).toBe(true);
    });

    it('close() on one socket throwing does not prevent the others from closing', () => {
        class ThrowingCloseNetwork extends FakeNetwork {
            public close(): void {
                throw new Error('boom on close');
            }
        }

        const main = new ThrowingCloseNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        expect(() => multi.close()).not.toThrow();
        expect(backup.readyState).toBe('closed');
    });

    it('subscribing the same onError handler twice fires it twice on both the delegated and local-emit paths, and unsubscribing one leaves exactly one', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        backup.close();
        const multi = createMultiSocketNetwork([main, backup]);

        const calls: MultiSocketErrorContext[] = [];
        const handler = (_error: any, context: SocketErrorContext) => calls.push(context as MultiSocketErrorContext);

        const unsubscribeFirst = multi.onError(handler);
        multi.onError(handler);

        main.emitError(new Error('m'), { scope: 'ownedWebSocket.close', network: main });
        expect(calls).toHaveLength(2); // delegated path: two subscriptions on main
        expect(calls.every(c => c.index === 0)).toBe(true);

        calls.length = 0;
        multi.sendAll('x'); // backup is dead -> local-emit path
        expect(calls).toHaveLength(2); // local emitter: two subscriptions fire twice
        expect(calls.every(c => c.index === 1)).toBe(true);

        calls.length = 0;
        unsubscribeFirst(); // remove exactly one of the two identical subscriptions
        multi.sendAll('y');
        expect(calls).toHaveLength(1); // local emitter: one subscription left -> exactly one firing
    });

    it('readyState/ready()/onOpen follow the main socket; missing optionals fall back (ready resolves immediately, onOpen is a noop unsubscribe)', async () => {
        const main = new FakeNetwork(false); // no ready/onOpen
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        expect(multi.readyState).toBe('open');
        main.readyState = 'closing';
        expect(multi.readyState).toBe('closing');
        main.readyState = 'open';

        await expect(multi.ready()).resolves.toBeUndefined();

        const unsubscribe = multi.onOpen(() => undefined);
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
    });

    it('configure() propagates the same options to every socket', () => {
        const main = new FakeNetwork();
        const backup = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, backup]);

        const options: SocketNetworkOptions = { latencyMs: 50, jitterMs: 10 };
        multi.configure(options);

        expect(main.configured).toEqual([options]);
        expect(backup.configured).toEqual([options]);
    });

    it('createMultiSocketNetwork() throws immediately when given fewer than 2 sockets', () => {
        expect(() => createMultiSocketNetwork([new FakeNetwork()])).toThrow();
        expect(() => createMultiSocketNetwork({ count: 1, networkFactory: () => new FakeNetwork() })).toThrow();
    });

    it('createMultiSocketNetwork({ count, networkFactory }) validates count before calling the factory: count<2 calls it zero times', () => {
        let calls = 0;
        const networkFactory = () => {
            calls++;
            return new FakeNetwork();
        };

        expect(() => createMultiSocketNetwork({ count: 0, networkFactory })).toThrow();
        expect(() => createMultiSocketNetwork({ count: 1, networkFactory })).toThrow();
        expect(calls).toBe(0); // validated before any factory call; no orphaned sockets from a side-effecting factory
    });

    it('createMultiSocketNetwork({ count, networkFactory }) calls the factory count times in index order and behaves like the array overload', () => {
        const networks: FakeNetwork[] = [];
        const calledIndexes: number[] = [];
        const multi = createMultiSocketNetwork({
            count: 3,
            networkFactory: index => {
                calledIndexes.push(index);
                const network = new FakeNetwork();
                networks.push(network);
                return network;
            },
        });

        expect(calledIndexes).toEqual([0, 1, 2]);

        multi.send('hello');
        expect(networks[0].sent).toEqual(['hello']);
        expect(networks[1].sent).toEqual([]);
        expect(networks[2].sent).toEqual([]);

        multi.sendAll('all');
        networks.forEach(network => expect(network.sent).toContain('all'));
    });

    it('supports an N=3 configuration: sendAll reaches all three sockets, receive merges from all three, and closing the middle socket isolates only that one', () => {
        const main = new FakeNetwork();
        const middle = new FakeNetwork();
        const last = new FakeNetwork();
        const multi = createMultiSocketNetwork([main, middle, last]);

        const received: string[] = [];
        multi.onMessage(data => received.push(data));

        multi.sendAll('frame');
        expect(main.sent).toEqual(['frame']);
        expect(middle.sent).toEqual(['frame']);
        expect(last.sent).toEqual(['frame']);

        main.emitMessage('m');
        middle.emitMessage('mid');
        last.emitMessage('l');
        expect(received).toEqual(['m', 'mid', 'l']);

        middle.close(); // direct close of the middle (index 1) socket only
        const errors: MultiSocketErrorContext[] = [];
        multi.onError((_error, context) => errors.push(context as MultiSocketErrorContext));

        expect(() => multi.sendAll('after-middle-close')).not.toThrow();
        expect(main.sent).toEqual(['frame', 'after-middle-close']);
        expect(last.sent).toEqual(['frame', 'after-middle-close']);
        expect(middle.sent).toEqual(['frame']); // middle did not send

        expect(errors).toHaveLength(1);
        expect(errors[0].index).toBe(1);
    });
});
