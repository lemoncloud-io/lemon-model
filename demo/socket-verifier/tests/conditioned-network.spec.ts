import { describe, it, expect, vi } from 'vitest';
import type { NetworkMessageHandler, NetworkSupportable, SocketErrorHandler } from '@socket/types';
import { createJSONTransport } from '@socket/transport';
import { createConditionedNetwork } from '../src/conditioned-network';
import { DEFAULT_VERIFIER_CONDITION, NetworkTapEvent, VerifierCondition } from '../src/types';

const condition = (overrides: Partial<VerifierCondition> = {}): VerifierCondition => ({
    ...DEFAULT_VERIFIER_CONDITION,
    ...overrides,
});

/** minimal fake `NetworkSupportable` that only records outbound frames (no delivery) */
const createFakeNetwork = (): NetworkSupportable & { sent: string[] } => {
    const sent: string[] = [];
    return {
        sent,
        readyState: 'open',
        ready: () => Promise.resolve(),
        onOpen: handler => {
            handler();
            return () => undefined;
        },
        send: data => sent.push(data),
        onMessage: () => () => undefined,
        configure: () => undefined,
        onError: () => () => undefined,
        close: () => undefined,
    };
};

/** two fake `NetworkSupportable` ends wired directly to each other (no library network involved) */
const createLinkedPair = (): [NetworkSupportable, NetworkSupportable] => {
    const aHandlers = new Set<NetworkMessageHandler>();
    const bHandlers = new Set<NetworkMessageHandler>();

    const a: NetworkSupportable = {
        readyState: 'open',
        ready: () => Promise.resolve(),
        onOpen: handler => {
            handler();
            return () => undefined;
        },
        send: data => {
            for (const handler of [...bHandlers]) handler(data);
        },
        onMessage: handler => {
            aHandlers.add(handler);
            return () => aHandlers.delete(handler);
        },
        configure: () => undefined,
        onError: () => () => undefined,
        close: () => undefined,
    };
    const b: NetworkSupportable = {
        readyState: 'open',
        ready: () => Promise.resolve(),
        onOpen: handler => {
            handler();
            return () => undefined;
        },
        send: data => {
            for (const handler of [...aHandlers]) handler(data);
        },
        onMessage: handler => {
            bHandlers.add(handler);
            return () => bHandlers.delete(handler);
        },
        configure: () => undefined,
        onError: () => () => undefined,
        close: () => undefined,
    };
    return [a, b];
};

describe('conditioned-network', () => {
    it('delays outbound send by latencyMs', () => {
        vi.useFakeTimers();
        const source = createFakeNetwork();
        const network = createConditionedNetwork(source, () => condition({ latencyMs: 50 }));

        network.send('hello');
        expect(source.sent).toEqual([]);

        vi.advanceTimersByTime(49);
        expect(source.sent).toEqual([]);

        vi.advanceTimersByTime(1);
        expect(source.sent).toEqual(['hello']);

        vi.useRealTimers();
    });

    it('reorders outbound frames when unordered+jitter produces a differential delay', () => {
        vi.useFakeTimers();
        const randomSpy = vi.spyOn(Math, 'random');
        randomSpy.mockReturnValueOnce(1).mockReturnValueOnce(0);

        const source = createFakeNetwork();
        const network = createConditionedNetwork(source, () =>
            condition({ latencyMs: 10, jitterMs: 100, unordered: true }),
        );

        network.send('first');
        network.send('second');

        vi.advanceTimersByTime(10);
        expect(source.sent).toEqual(['second']);

        vi.advanceTimersByTime(100);
        expect(source.sent).toEqual(['second', 'first']);

        randomSpy.mockRestore();
        vi.useRealTimers();
    });

    it('drops outbound frames when dropRate triggers, emitting a drop tap', () => {
        const source = createFakeNetwork();
        const taps: NetworkTapEvent[] = [];
        const network = createConditionedNetwork(source, () => condition({ dropRate: 1 }), event => taps.push(event));

        network.send('lost');

        expect(source.sent).toEqual([]);
        expect(taps).toHaveLength(1);
        expect(taps[0].kind).toBe('drop');
    });

    it('throws 1009 when the outbound frame exceeds maxPacketBytes', () => {
        const source = createFakeNetwork();
        const network = createConditionedNetwork(source, () => condition({ maxPacketBytes: 4 }));

        expect(() => network.send('too-large')).toThrow('1009: message too big');
        expect(source.sent).toEqual([]);
    });

    it('corrupts json:chunk payloads so the receiving transport raises json.chunk.hash (01 regression guard)', () => {
        const [a, b] = createLinkedPair();
        const conditionedA = createConditionedNetwork(a, () => condition({ corruptRate: 1 }));

        const sender = createJSONTransport<{ type: string; data: { text: string } }>(conditionedA, {
            largeValueBytes: 8,
            chunkBytes: 16,
        });
        const errorHandler: SocketErrorHandler = () => undefined;
        sender.onError(errorHandler); // sanity: sender itself must not throw synchronously

        const receiver = createJSONTransport<{ type: string; data: { text: string } }>(b, {
            largeValueBytes: 8,
            chunkBytes: 16,
        });
        const scopes: string[] = [];
        receiver.onError((_error, context) => scopes.push(context.scope));

        sender.send({ type: 'text', data: { text: 'x'.repeat(64) } });

        expect(scopes).toContain('json.chunk.hash');
    });
});
