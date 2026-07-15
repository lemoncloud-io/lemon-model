/**
 * mode-A (in-memory peer) verification session (01-spec decision 1, 02-design module decomposition).
 * `createSocketFactory`/`createPeer` only — no `jsonTransport` (chunking is mode B's concern).
 */
import { createSocketFactory, nextMessageId } from '@socket/testing';
import type { PeerSupportable, SocketLogEntry, SocketLogger } from '@socket/types';
import type { NewTimelineEvent, VerifierStore } from './verifier-store';
import type { VerifierCondition, VerifierSession } from './types';

interface PeerSessionOptions {
    id: string;
    store: VerifierStore;
}

/** `Peer.publish` message types this session emits; `peer.publish` log entries carrying them become an `out` event */
const isPublishedKind = (type?: string): type is 'send' | 'post' | 'ping' =>
    type === 'send' || type === 'post' || type === 'ping';

/** `Peer.dispatch` resolves pending sends via `result`/`pong`; a `peer.dispatch.result` log entry becomes an `in` event */
const isResolvedKind = (type?: string): type is 'result' | 'pong' => type === 'result' || type === 'pong';

/**
 * convert one `Peer` log entry into a timeline event; correlates via `entry.mid`.
 * unknown `location`/`type` combinations are dropped silently (02-design risk: location string fragility).
 * `sentAt` (mid -> dispatch time, owned by the session) lets a `result`/`pong` append its round-trip Δms.
 */
const toTimelineEvent = (
    connectionId: string,
    entry: SocketLogEntry,
    sentAt: Map<string, number>,
): NewTimelineEvent | undefined => {
    if (entry.location === 'peer.publish' && isPublishedKind(entry.type)) {
        if (entry.level === 'error') {
            return {
                connectionId,
                direction: 'sys',
                kind: 'error',
                severity: 'error',
                detail: `${entry.type} publish failed mid=${entry.mid ?? ''}: ${entry.error ?? ''}`,
                meta: { mid: entry.mid },
            };
        }
        if ((entry.type === 'send' || entry.type === 'ping') && entry.mid) sentAt.set(entry.mid, entry.time);
        return {
            connectionId,
            direction: 'out',
            kind: entry.type,
            severity: 'normal',
            detail: `${entry.type} mid=${entry.mid ?? ''}`,
            meta: { mid: entry.mid },
        };
    }
    if (entry.location === 'peer.dispatch.result' && isResolvedKind(entry.type)) {
        const mid = entry.mid;
        const dispatchedAt = mid ? sentAt.get(mid) : undefined;
        if (dispatchedAt === undefined) {
            return {
                connectionId,
                direction: 'in',
                kind: entry.type,
                severity: 'normal',
                detail: `${entry.type} mid=${mid ?? ''}`,
                meta: { mid },
            };
        }
        sentAt.delete(mid!);
        const elapsedMs = entry.time - dispatchedAt;
        return {
            connectionId,
            direction: 'in',
            kind: entry.type,
            severity: 'normal',
            detail: `${entry.type} mid=${mid ?? ''} (+${elapsedMs}ms)`,
            meta: { mid, elapsedMs },
        };
    }
    return undefined;
};

class PeerSession implements VerifierSession {
    private readonly id: string;
    private readonly store: VerifierStore;
    private readonly client: PeerSupportable<any, any>;
    private readonly server: PeerSupportable<any, any>;
    /** mid -> dispatch time for in-flight `send`/`ping`, consumed by `toTimelineEvent` on `result`/`pong` */
    private readonly sentAt = new Map<string, number>();

    public constructor(options: PeerSessionOptions) {
        this.id = options.id;
        this.store = options.store;

        const logger: SocketLogger = {
            log: entry => {
                const event = toTimelineEvent(this.id, entry, this.sentAt);
                if (event) this.store.pushEvent(event);
            },
        };
        const factory = createSocketFactory({ logger });
        this.server = factory.peer({ id: `${this.id}-server` });
        this.client = factory.peer({ id: `${this.id}-client` });

        /** echo responder: returning the payload lets the library auto-reply with a `result`, closing the send→result loop */
        this.server.onMessage(message => message.data);
        const onPeerError = (error: any) => {
            this.store.pushEvent({
                connectionId: this.id,
                direction: 'sys',
                kind: 'error',
                severity: 'error',
                detail: String(error?.message ?? error),
            });
        };
        this.server.onError(onPeerError);
        this.client.onError(onPeerError);
    }

    public async connect(): Promise<void> {
        this.client.connect(this.server);
        this.store.updateConnection(this.id, { status: 'open' });
        this.store.pushEvent({
            connectionId: this.id,
            direction: 'sys',
            kind: 'open',
            severity: 'normal',
            detail: 'connected',
        });
    }

    public close(): void {
        this.client.close();
        this.server.close();
        this.store.updateConnection(this.id, { status: 'closed' });
        this.store.pushEvent({
            connectionId: this.id,
            direction: 'sys',
            kind: 'close',
            severity: 'normal',
            detail: 'closed',
        });
    }

    public async reconnect(): Promise<void> {
        this.client.reconnect();
        this.store.pushEvent({
            connectionId: this.id,
            direction: 'sys',
            kind: 'reconnect',
            severity: 'normal',
            detail: 'reconnected',
        });
    }

    public async send(payload: unknown): Promise<void> {
        await this.client.send({ type: 'send', data: payload });
    }

    public post(payload: unknown): void {
        this.client.post({ type: 'post', data: payload, mid: nextMessageId() });
    }

    public async ping(data?: unknown): Promise<void> {
        await this.client.send({ type: 'ping', data });
    }

    /** `configureNetwork` only takes latencyMs/jitterMs/unordered/maxPacketBytes — dropRate/corruptRate are mode-B only (01 Out of Scope) */
    public configure(condition: VerifierCondition): void {
        const jitterMs = condition.unordered && condition.jitterMs === 0 ? 1 : condition.jitterMs;
        const applied: VerifierCondition = { ...condition, jitterMs };
        const options = {
            latencyMs: applied.latencyMs,
            jitterMs: applied.jitterMs,
            unordered: applied.unordered,
            maxPacketBytes: applied.maxPacketBytes,
        };
        this.client.configureNetwork(options);
        this.server.configureNetwork(options);

        this.store.updateConnection(this.id, { condition: applied });
        this.store.pushEvent({
            connectionId: this.id,
            direction: 'sys',
            kind: 'configure',
            severity: 'normal',
            detail: `latency=${options.latencyMs} jitter=${options.jitterMs} unordered=${options.unordered}`,
            meta: { ...options },
        });
    }
}

/** create a mode-A (in-memory peer) verification session for one connection panel */
export const createPeerSession = (options: PeerSessionOptions): VerifierSession => new PeerSession(options);
