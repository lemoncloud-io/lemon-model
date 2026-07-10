/** shared model types for the socket-visual-verifier demo (02-design.md data modeling section) */

/** kinds of timeline entries emitted by either verification path */
export type TimelineKind =
    | 'open'
    | 'handshake'
    | 'close'
    | 'reconnect'
    | 'configure'
    | 'send'
    | 'post'
    | 'receive'
    | 'result'
    | 'ping'
    | 'pong'
    | 'chunk-out'
    | 'assemble'
    | 'pending'
    | 'expired'
    | 'drop'
    | 'corrupt'
    | 'error';

/** one entry of the shared timeline; `seq` is the monotonic sort key */
export interface TimelineEvent {
    /** monotonic sequence number assigned by the store */
    seq: number;
    /** epoch ms */
    at: number;
    /** connection/panel this event belongs to */
    connectionId: string;
    /** receive / send / lifecycle-or-error */
    direction: 'in' | 'out' | 'sys';
    kind: TimelineKind;
    /** normal flow vs contract violation (client sync contract) */
    severity: 'normal' | 'error';
    /** human-readable summary */
    detail: string;
    /** original reference data (mid, tid, scope, code, ...) */
    meta?: Record<string, any>;
}

/** condition model applied to outbound traffic (01-spec model contract) */
export interface VerifierCondition {
    /** base artificial delivery latency in ms */
    latencyMs: number;
    /** additional random delay in ms */
    jitterMs: number;
    /** allow back-to-back messages to be delivered out of order */
    unordered: boolean;
    /** maximum raw packet size in bytes before a 1009 guard fires */
    maxPacketBytes: number;
    /** probability (0~1) an outbound packet is dropped */
    dropRate: number;
    /** probability (0~1) an outbound json:chunk payload is corrupted */
    corruptRate: number;
}

/** default condition values (02-design VerifierCondition table) */
export const DEFAULT_VERIFIER_CONDITION: VerifierCondition = {
    latencyMs: 0,
    jitterMs: 0,
    unordered: false,
    maxPacketBytes: 65536,
    dropRate: 0,
    corruptRate: 0,
};

/** panel/connection state (02-design ConnectionState table) */
export interface ConnectionState {
    /** panel identifier, shared with TimelineEvent.connectionId */
    id: string;
    /** verification path: in-memory peer vs real websocket */
    mode: 'peer' | 'ws';
    /** reflects the underlying readyState */
    status: 'connecting' | 'open' | 'closing' | 'closed';
    /** server-issued connectionId (mode 'ws' only) */
    remoteConnectionId?: string;
    /** current condition applied to this connection */
    condition: VerifierCondition;
    /** transport.pendingCount snapshot (reassembly in-flight count) */
    pendingCount: number;
}

/** minimal common surface of both sessions (02-design module decomposition); `ping` exists on mode 'peer' only */
export interface VerifierSession {
    connect(): Promise<void>;
    close(): void;
    reconnect(): Promise<void>;
    /** mode 'peer': awaits the correlated result / mode 'ws': raw send, round-trip observed via echo */
    send(payload: unknown): Promise<void>;
    post(payload: unknown): void;
    ping?(data?: unknown): Promise<void>;
    configure(condition: VerifierCondition): void;
}

/** kinds tapped by the conditioned-network decorator (outbound-only injections) */
export type NetworkTapKind = 'chunk-out' | 'drop' | 'corrupt';

/** event exposed by conditioned-network's onTap for outbound injections */
export interface NetworkTapEvent {
    kind: NetworkTapKind;
    /** epoch ms when the tap fired */
    at: number;
    /** outbound raw frame (post-mutation for 'corrupt') */
    raw: string;
    /** parsed json:chunk identifiers when available */
    meta?: { tid?: string; cid?: string; index?: number; total?: number; bytes?: number };
}
