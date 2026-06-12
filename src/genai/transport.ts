/**
 * `genai/transport.ts`
 * - JSONTransport-backed receiver for collecting GenAI generate results over `NetworkSupportable`.
 * - the generic WebSocket → `NetworkSupportable` bridge lives in the shared socket core (`../socket/websocket`).
 *
 * @origin eureka-agents-api / src/lib/proxy/transport.ts (receiver parts; the WebSocket bridge was extracted into `../socket/websocket`)
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { createJSONTransport, JSONTransportOptions, JSONTransportPacket } from '../socket/transport';
import { NetworkSupportable } from '../socket/types';
import { createFilteredNetwork } from '../socket/websocket';
import { ProxyTransportReceiver } from './types';

/** options for receiving a single JSONTransport response */
export interface ProxyTransportReceiverOptions<T extends object = object> {
    timeoutMs?: number;
    jsonTransport?: JSONTransportOptions;
    validate?: (data: T) => boolean;
}

interface PendingWait<T extends object> {
    transportId: string;
    resolve: (data: T) => void;
    reject: (error: any) => void;
    timer?: ReturnType<typeof setTimeout>;
}

/** JSONTransport-backed receiver used by `HttpAbstractGenAI` transport mode */
export class JSONProxyTransportReceiver<T extends object = object> implements ProxyTransportReceiver<T> {
    private readonly transport;
    private pending?: PendingWait<T>;

    public constructor(
        private readonly network: NetworkSupportable,
        private readonly options: ProxyTransportReceiverOptions<T> = {},
    ) {
        this.transport = createJSONTransport<T>(
            createFilteredNetwork(network, isTransportPacketString),
            options.jsonTransport,
        );
        this.transport.onMessage(data => this.resolve(data));
        this.transport.onError(error => this.reject(error));
    }

    /**
     * Run an HTTP trigger task and resolve with the next complete JSONTransport payload.
     *
     * Only one pending wait is supported per receiver instance.
     */
    public async wait(transportId: string, task: () => Promise<unknown>): Promise<T> {
        if (this.pending) throw new Error(`@transport is already waiting - proxy.transport(${transportId})`);
        if (!transportId) throw new Error(`@transportId (string) is required - proxy.transport`);

        const promise = new Promise<T>((resolve, reject) => {
            const timeoutMs = this.options.timeoutMs ?? 30_000;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.reject(new Error(`@transport[${transportId}] timeout - proxy.transport`));
                      }, timeoutMs)
                    : undefined;
            this.pending = { transportId, resolve, reject, timer };
        });

        try {
            await task();
        } catch (e) {
            this.reject(e);
        }

        return promise;
    }

    /** detach listeners and reject an in-flight wait */
    public detach(): void {
        this.reject(new Error(`@transport detached - proxy.transport`));
        this.transport.detach();
    }

    private resolve(data: T): void {
        if (!this.pending) return;
        if (this.options.validate && !this.options.validate(data)) return;
        const pending = this.pending;
        this.pending = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(data);
    }

    private reject(error: any): void {
        if (!this.pending) return;
        const pending = this.pending;
        this.pending = undefined;
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
    }
}

/** create a receiver that filters raw network packets down to JSONTransport frames */
export const createProxyTransportReceiver = <T extends object = object>(
    network: NetworkSupportable,
    options?: ProxyTransportReceiverOptions<T>,
): JSONProxyTransportReceiver<T> => new JSONProxyTransportReceiver<T>(network, options);

/** raw predicate: keep only JSONTransport frame strings */
const isTransportPacketString = (data: string): boolean => {
    try {
        const packet = JSON.parse(data) as Partial<JSONTransportPacket>;
        return (
            packet?.type === 'json:manifest' ||
            packet?.type === 'json:chunk' ||
            packet?.type === 'json:complete' ||
            packet?.type === 'json:error'
        );
    } catch {
        return false;
    }
};
