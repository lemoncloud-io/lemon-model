/**
 * Peer 왕복(reliable) 데모 세션 — 권장 진입점 `createPeer({ reliable: true })` 단축 플래그만으로
 * 클라/서버 Peer 쌍(인메모리)을 세워 send 왕복을 보여준다. `@socket/testing` 은 패키지의 공개
 * `lemon-model/socket/testing` 엔트리(dev/test 전용 시뮬레이터)를 가리키는 데모 번들 별칭이다 —
 * peer-session.ts 의 저수준 `createSocketFactory` 대신 여기서는 상위 진입점 하나만 쓴다.
 *
 * reliable 경로에서 왕복은 세 신호로 드러난다(실측): 클라의 `peer.publish send`(out),
 * exactly-once 확인 `json.receive json:ack`(in, tid 보유), 서버 echo가 되돌린 `peer.dispatch.result`(in).
 * json.* 로그는 peerId 가 비어 오지만 로거가 이 세션 전용이라 전부 `id` 에 귀속시킨다.
 */
import { createPeer, nextMessageId } from '@socket/testing';
import type { PeerSupportable, SocketLogEntry, SocketLogger } from '@socket/types';
import type { NewTimelineEvent, VerifierStore } from './verifier-store';
import type { VerifierCondition, VerifierSession } from './types';

interface PeerReliableSessionOptions {
    id: string;
    store: VerifierStore;
}

const isPublishedKind = (type?: string): type is 'send' | 'post' | 'ping' =>
    type === 'send' || type === 'post' || type === 'ping';

const isResolvedKind = (type?: string): type is 'result' | 'pong' => type === 'result' || type === 'pong';

class PeerReliableSession implements VerifierSession {
    private readonly id: string;
    private readonly store: VerifierStore;
    private readonly client: PeerSupportable<any, any>;
    private readonly server: PeerSupportable<any, any>;
    /** mid -> dispatch time for in-flight `send`/`ping`, consumed on the correlated `result`/`pong` */
    private readonly sentAt = new Map<string, number>();

    public constructor(options: PeerReliableSessionOptions) {
        this.id = options.id;
        this.store = options.store;

        const logger: SocketLogger = { log: entry => this.onLog(entry) };
        //! both peers must opt into `reliable` — an asymmetric pair surfaces as `json.reliable.mismatch`
        this.server = createPeer({ id: `${this.id}-server`, reliable: true, logger });
        this.client = createPeer({ id: `${this.id}-client`, reliable: true, logger });

        /** echo responder: returning the payload makes the library auto-reply with a `result`, closing send→result */
        this.server.onMessage(message => message.data);
        const onPeerError = (error: any) =>
            this.push({ direction: 'sys', kind: 'error', severity: 'error', detail: String(error?.message ?? error) });
        this.server.onError(onPeerError);
        this.client.onError(onPeerError);
    }

    private push(event: Omit<NewTimelineEvent, 'connectionId'>): void {
        this.store.pushEvent({ connectionId: this.id, ...event });
    }

    private onLog(entry: SocketLogEntry): void {
        if (entry.location === 'peer.publish' && isPublishedKind(entry.type)) {
            if (entry.level === 'error') {
                this.push({
                    direction: 'sys',
                    kind: 'error',
                    severity: 'error',
                    detail: `${entry.type} publish failed mid=${entry.mid ?? ''}: ${entry.error ?? ''}`,
                    meta: { mid: entry.mid },
                });
                return;
            }
            if ((entry.type === 'send' || entry.type === 'ping') && entry.mid) this.sentAt.set(entry.mid, entry.time);
            this.push({
                direction: 'out',
                kind: entry.type,
                severity: 'normal',
                detail: `${entry.type} mid=${entry.mid ?? ''}`,
                meta: { mid: entry.mid },
            });
            return;
        }
        // reliable exactly-once confirmation of a delivered transmission (send leg + returning result leg)
        if (entry.location === 'json.receive' && (entry.data as any)?.type === 'json:ack') {
            const tid = (entry.data as any)?.tid;
            this.push({
                direction: 'in',
                kind: 'ack',
                severity: 'normal',
                detail: `ack tid=${tid ?? ''}`,
                meta: { tid },
            });
            return;
        }
        if (entry.location === 'peer.dispatch.result' && isResolvedKind(entry.type)) {
            const mid = entry.mid;
            const dispatchedAt = mid ? this.sentAt.get(mid) : undefined;
            if (mid && dispatchedAt !== undefined) this.sentAt.delete(mid);
            const suffix = dispatchedAt === undefined ? '' : ` (+${entry.time - dispatchedAt}ms)`;
            this.push({
                direction: 'in',
                kind: entry.type,
                severity: 'normal',
                detail: `${entry.type} mid=${mid ?? ''}${suffix}`,
                meta: { mid, elapsedMs: dispatchedAt === undefined ? undefined : entry.time - dispatchedAt },
            });
        }
    }

    public async connect(): Promise<void> {
        this.client.connect(this.server);
        this.store.updateConnection(this.id, { status: 'open' });
        this.push({ direction: 'sys', kind: 'open', severity: 'normal', detail: 'connected (reliable peer)' });
    }

    public close(): void {
        this.client.close();
        this.server.close();
        this.store.updateConnection(this.id, { status: 'closed' });
        this.push({ direction: 'sys', kind: 'close', severity: 'normal', detail: 'closed' });
    }

    public async reconnect(): Promise<void> {
        this.client.reconnect();
        this.push({ direction: 'sys', kind: 'reconnect', severity: 'normal', detail: 'reconnected' });
    }

    public async send(payload: unknown): Promise<void> {
        await this.client.send({ type: 'send', data: payload });
    }

    public post(payload: unknown): void {
        this.client.post({ type: 'post', data: payload, mid: nextMessageId() });
    }

    /** peer network only honors latency/jitter/unordered/maxPacketBytes — dropRate/corruptRate are mode-B only */
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
        this.push({
            direction: 'sys',
            kind: 'configure',
            severity: 'normal',
            detail: `latency=${options.latencyMs} jitter=${options.jitterMs} unordered=${options.unordered}`,
            meta: { ...options },
        });
    }
}

/** create a reliable in-memory Peer round-trip session for one connection panel */
export const createPeerReliableSession = (options: PeerReliableSessionOptions): VerifierSession =>
    new PeerReliableSession(options);
