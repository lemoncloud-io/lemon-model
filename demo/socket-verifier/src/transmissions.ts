/**
 * Derives per-panel "transmission" cards from the shared timeline (P0-1/P0-2 demo UX).
 * A transmission is one send unit, keyed by its transport id (`tid`). All state is folded
 * purely from existing TimelineEvents — no new event kinds — so the cards stay a faithful
 * projection of what the timeline already shows: chunk-out/drop/nack/resend/ack on the sender
 * side, receive(json:chunk)/assemble on the receiver side.
 */
import type { TimelineEvent } from './types';

/** per-chunk cell display state (sender or receiver grid) */
export type CellState = 'missing' | 'pending' | 'resend' | 'dropped' | 'delivered';

export interface ChunkCell {
    state: CellState;
    /** the chunk was dropped at least once and later re-sent (keeps the recovery visible after success) */
    recovered: boolean;
}

/** transmission lifecycle chip */
export type CardStatus = 'sending' | 'resending' | 'nack' | 'acked' | 'assembled' | 'failed';

export interface TransmissionCard {
    tid: string;
    /** this panel's role for this tid: it emitted chunks (sender) or received them (receiver) */
    role: 'sender' | 'receiver';
    /** known chunk count (0 when the payload fit inline / count not yet observed) */
    total: number;
    cells: ChunkCell[];
    status: CardStatus;
    /** highest blind-resend attempt observed */
    attempt: number;
    nackCount: number;
    dropCount: number;
    /** seq of the earliest event for ordering (newest transmission first) */
    seq: number;
}

interface MutableCell {
    sent: boolean;
    dropped: boolean;
    resent: boolean;
    delivered: boolean;
}

interface MutableCard {
    tid: string;
    role: 'sender' | 'receiver';
    total: number;
    cells: MutableCell[];
    status: CardStatus;
    terminal: boolean;
    attempt: number;
    nackCount: number;
    dropCount: number;
    seq: number;
    /** receiver side: highest chunk index delivered so far, for spotting out-of-order (recovered) arrivals */
    maxIndex: number;
}

const TID_IN_DETAIL = /(?:@json\[|tid=)([0-9a-f-]{8,})/i;

/** the transmission id of an event: `meta.tid` when present, else parsed from the detail (`@json[<tid>] ...`) */
export const tidOf = (event: TimelineEvent): string | undefined => {
    const metaTid = event.meta?.tid;
    if (typeof metaTid === 'string') return metaTid;
    const match = event.detail.match(TID_IN_DETAIL);
    return match?.[1];
};

const cellAt = (card: MutableCard, index: number): MutableCell => {
    while (card.cells.length <= index) {
        card.cells.push({ sent: false, dropped: false, resent: false, delivered: false });
    }
    return card.cells[index];
};

const growTotal = (card: MutableCard, total: unknown): void => {
    if (typeof total === 'number' && total > card.total) {
        card.total = total;
        cellAt(card, total - 1);
    }
};

/** fold this connection's events into one card per tid; newest transmission first, capped at `limit` */
export const deriveTransmissions = (events: TimelineEvent[], connectionId: string, limit = 4): TransmissionCard[] => {
    const byTid = new Map<string, MutableCard>();

    const ensure = (tid: string, role: 'sender' | 'receiver', seq: number): MutableCard => {
        let card = byTid.get(tid);
        if (!card) {
            card = {
                tid,
                role,
                total: 0,
                cells: [],
                status: role === 'sender' ? 'sending' : 'assembled',
                terminal: false,
                attempt: 0,
                nackCount: 0,
                dropCount: 0,
                seq,
                maxIndex: -1,
            };
            if (role === 'receiver') card.status = 'sending';
            byTid.set(tid, card);
        }
        return card;
    };

    const setStatus = (card: MutableCard, status: CardStatus): void => {
        if (card.terminal) return;
        card.status = status;
    };

    const markTerminal = (card: MutableCard, status: 'acked' | 'assembled' | 'failed'): void => {
        card.status = status;
        card.terminal = true;
    };

    /** attribute a tid-less terminal (expired / bare reliable-fail) to the latest still-active sender card */
    const latestActiveSender = (): MutableCard | undefined => {
        let latest: MutableCard | undefined;
        for (const card of byTid.values()) {
            if (card.role !== 'sender' || card.terminal) continue;
            if (!latest || card.seq > latest.seq) latest = card;
        }
        return latest;
    };

    const ordered = events.filter(e => e.connectionId === connectionId).sort((a, b) => a.seq - b.seq);

    for (const event of ordered) {
        const tid = tidOf(event);
        switch (event.kind) {
            case 'chunk-out': {
                if (!tid || typeof event.meta?.index !== 'number') break;
                const card = ensure(tid, 'sender', event.seq);
                growTotal(card, event.meta?.total);
                const cell = cellAt(card, event.meta.index);
                if (cell.sent || cell.dropped) cell.resent = true;
                cell.sent = true;
                break;
            }
            case 'drop': {
                if (!tid || typeof event.meta?.index !== 'number') break;
                const card = ensure(tid, 'sender', event.seq);
                growTotal(card, event.meta?.total);
                cellAt(card, event.meta.index).dropped = true;
                card.dropCount += 1;
                break;
            }
            case 'nack': {
                if (!tid) break;
                const card = ensure(tid, 'sender', event.seq);
                card.nackCount += 1;
                setStatus(card, 'nack');
                break;
            }
            case 'resend': {
                if (!tid) break;
                const card = ensure(tid, 'sender', event.seq);
                const attempt = event.meta?.attempt;
                if (typeof attempt === 'number') card.attempt = Math.max(card.attempt, attempt);
                setStatus(card, 'resending');
                break;
            }
            case 'ack': {
                if (!tid) break;
                markTerminal(ensure(tid, 'sender', event.seq), 'acked');
                break;
            }
            case 'reliable-fail': {
                const card = tid ? byTid.get(tid) : latestActiveSender();
                if (card) markTerminal(card, 'failed');
                break;
            }
            case 'expired': {
                const card = latestActiveSender();
                if (card) markTerminal(card, 'failed');
                break;
            }
            case 'receive': {
                if (event.direction !== 'in' || event.meta?.type !== 'json:chunk') break;
                if (!tid || typeof event.meta?.index !== 'number') break;
                const card = ensure(tid, 'receiver', event.seq);
                growTotal(card, event.meta?.total);
                const index = event.meta.index;
                const cell = cellAt(card, index);
                // a re-delivery, or a chunk landing after a higher index already arrived, means this chunk
                // was recovered (gap-fill after loss) — mirror the sender's recovered (orange-ring) marking
                if (cell.delivered || index < card.maxIndex) cell.resent = true;
                cell.delivered = true;
                if (index > card.maxIndex) card.maxIndex = index;
                break;
            }
            case 'assemble': {
                if (!tid) break;
                markTerminal(ensure(tid, 'receiver', event.seq), 'assembled');
                break;
            }
        }
    }

    const finalize = (card: MutableCard): TransmissionCard => {
        const done = card.status === 'acked' || card.status === 'assembled';
        const cells: ChunkCell[] = card.cells.map(cell => {
            const recovered = cell.resent || (cell.dropped && cell.delivered);
            if (done || cell.delivered) return { state: 'delivered', recovered };
            if (cell.dropped) return { state: 'dropped', recovered };
            if (cell.resent) return { state: 'resend', recovered };
            if (cell.sent) return { state: 'pending', recovered };
            return { state: 'missing', recovered };
        });
        return {
            tid: card.tid,
            role: card.role,
            total: card.total,
            cells,
            status: card.status,
            attempt: card.attempt,
            nackCount: card.nackCount,
            dropCount: card.dropCount,
            seq: card.seq,
        };
    };

    return [...byTid.values()]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map(finalize);
};
