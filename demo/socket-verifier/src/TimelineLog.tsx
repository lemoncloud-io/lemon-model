/** shared timeline: renders every TimelineEvent newest-first with connection/severity/kind visual cues (02-design.md, 01-spec client sync contract) */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ConnectionState, TimelineEvent, TimelineKind } from './types';
import { tidOf } from './transmissions';

interface TimelineLogProps {
    events: TimelineEvent[];
    connections: ConnectionState[];
}

/** fixed palette so a connection keeps the same badge color across its lifetime */
const PALETTE = ['#4dabf7', '#69db7c', '#ffa94d', '#ff6b6b', '#da77f2', '#63e6be', '#ffe066', '#e599f7'];

const hashCode = (id: string): number => {
    let hash = 0;
    for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
    return Math.abs(hash);
};

/** stable color for a connectionId — used by both the timeline and connection panel badges */
export const connectionColor = (id: string): string => PALETTE[hashCode(id) % PALETTE.length];

const DIRECTION_ARROW: Record<TimelineEvent['direction'], string> = { in: '←', out: '→', sys: '·' };

/** kinds worth a visual nudge beyond severity coloring (01-spec fault-detection scenarios) */
const KIND_HINT_CLASS: Partial<Record<TimelineKind, string>> = {
    'chunk-out': 'kind-chunk',
    drop: 'kind-drop',
    corrupt: 'kind-corrupt',
    expired: 'kind-expired',
    duplicate: 'kind-duplicate',
    ack: 'kind-ack',
    nack: 'kind-nack',
    resend: 'kind-resend',
    'reliable-fail': 'kind-reliable-fail',
};

/** short human label for a collapsed run of one kind (`dropped chunk ×25`) */
const KIND_SUMMARY: Partial<Record<TimelineKind, string>> = {
    'chunk-out': 'chunk out',
    drop: 'dropped chunk',
    corrupt: 'corrupted chunk',
    receive: 'chunk in',
    resend: 'resend',
};

/** runs of the same (kind, tid) at or above this length collapse into one aggregate row by default */
const COLLAPSE_THRESHOLD = 3;

/** coarse KB for an aggregate size (`~66KB`); mirrors ws-session's aggregate formatter */
const formatBytes = (n: number): string => (n >= 1024 ? `~${Math.round(n / 1024)}KB` : `${n}B`);

/** trim long transmission ids inside a detail string to 8 chars; the row's title keeps the full text */
const shortenIds = (detail: string): string =>
    detail
        .replace(
            /(@json\[)([0-9a-f][0-9a-f-]{7,})(\])/gi,
            (_all, prefix, value, suffix) => `${prefix}${value.slice(0, 8)}…${suffix}`,
        )
        .replace(/((?:tid|cid)=)([0-9a-f][0-9a-f-]{7,})/gi, (_all, prefix, value) => `${prefix}${value.slice(0, 8)}…`);

const formatTime = (at: number): string => {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
};

/** one on-screen block: a lone event, or a collapsible run of same-(kind, tid) events */
interface RowGroup {
    key: string;
    kind: TimelineKind;
    tid?: string;
    items: TimelineEvent[];
}

/**
 * extra summary for a collapsed run: the index span the folded chunks cover plus their aggregate size
 * (`0~4 · ~66KB`). For drops it swaps size for a resend-round hint (`chunk 0~4 · 재전송 2회분`) so a
 * `×10` over 5 chunks reads as 5 chunks × 2 attempts rather than an opaque count.
 */
const groupSummary = (group: RowGroup): string => {
    const indices = group.items
        .map(e => (typeof e.meta?.index === 'number' ? e.meta.index : undefined))
        .filter((i): i is number => i !== undefined);
    const bytes = group.items.reduce((sum, e) => sum + (typeof e.meta?.bytes === 'number' ? e.meta.bytes : 0), 0);
    if (indices.length === 0) return bytes > 0 ? `(${formatBytes(bytes)})` : '';
    const min = Math.min(...indices);
    const max = Math.max(...indices);
    const span = min === max ? `${min}` : `${min}~${max}`;
    if (group.kind === 'drop') {
        const rounds = Math.round(group.items.length / new Set(indices).size);
        return `(chunk ${span}${rounds >= 2 ? ` · 재전송 ${rounds}회분` : ''})`;
    }
    return `(${span} · ${formatBytes(bytes)})`;
};

/** fold the newest-first list into groups, merging consecutive same-(kind, tid) rows (tid required to merge) */
const groupRows = (sorted: TimelineEvent[]): RowGroup[] => {
    const groups: RowGroup[] = [];
    for (const event of sorted) {
        const tid = tidOf(event);
        const last = groups[groups.length - 1];
        if (last && tid && last.tid === tid && last.kind === event.kind) {
            last.items.push(event);
        } else {
            groups.push({ key: `g-${event.seq}`, kind: event.kind, tid, items: [event] });
        }
    }
    return groups;
};

/** how much of a retained payload the detail panel renders inline; the copy button always copies the full stored string */
const PAYLOAD_DISPLAY_CAP = 20 * 1024;

/** a single event row (also reused for a group's expanded children); rows carrying a payload expand to show it */
const EventRow = ({ event, child }: { event: TimelineEvent; child?: boolean }) => {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const payload = typeof event.meta?.payload === 'string' ? (event.meta.payload as string) : undefined;
    const storeTruncated = event.meta?.payloadTruncated === true;
    const fullBytes = typeof event.meta?.payloadBytes === 'number' ? event.meta.payloadBytes : payload?.length ?? 0;
    const shown = payload && payload.length > PAYLOAD_DISPLAY_CAP ? payload.slice(0, PAYLOAD_DISPLAY_CAP) : payload;
    const displayTruncated = !!payload && payload.length > PAYLOAD_DISPLAY_CAP;

    const copy = (event_: MouseEvent) => {
        event_.stopPropagation();
        if (!payload || storeTruncated) return;
        navigator.clipboard?.writeText(payload).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        });
    };

    return (
        <>
            <div
                className={`timeline-row ${child ? 'timeline-child' : ''} ${
                    event.severity === 'error' ? 'row-error' : ''
                } ${payload !== undefined ? 'row-payload' : ''} ${KIND_HINT_CLASS[event.kind] ?? ''}`}
                onClick={payload !== undefined ? () => setOpen(prev => !prev) : undefined}
            >
                <span className="col-seq">#{event.seq}</span>
                <span className="col-time">{formatTime(event.at)}</span>
                <span className="col-conn" style={{ backgroundColor: connectionColor(event.connectionId) }}>
                    {event.connectionId}
                </span>
                <span className="col-direction">{DIRECTION_ARROW[event.direction]}</span>
                <span className="col-kind">{event.kind}</span>
                <span className="col-detail" title={event.detail}>
                    {payload !== undefined && <span className="payload-caret">{open ? '▾' : '▸'}</span>}
                    {typeof event.meta?.socketIndex === 'number' && (
                        <span className="socket-chip">S{event.meta?.socketIndex}</span>
                    )}
                    {shortenIds(event.detail)}
                </span>
            </div>
            {payload !== undefined && open && (
                <div className={`payload-detail ${child ? 'timeline-child' : ''}`}>
                    <div className="payload-detail-head">
                        <span className="payload-size">payload · {formatBytes(fullBytes)}</span>
                        <button className="payload-copy" onClick={copy} disabled={storeTruncated}>
                            {copied ? '복사됨' : '복사'}
                        </button>
                    </div>
                    <pre className="payload-body">
                        {shown}
                        {displayTruncated && `\n… truncated (전체 ${formatBytes(fullBytes)})`}
                    </pre>
                    {storeTruncated && (
                        <p className="payload-note">저장 상한(512KB) 초과 — 전체 미보존이라 복사할 수 없습니다.</p>
                    )}
                </div>
            )}
        </>
    );
};

/** renders the full shared timeline, newest event on top */
const TimelineLog = ({ events }: TimelineLogProps) => {
    const [autoScroll, setAutoScroll] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (autoScroll && listRef.current) listRef.current.scrollTop = 0;
    }, [events.length, autoScroll]);

    const toggle = (key: string) =>
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(key) ? next.delete(key) : next.add(key);
            return next;
        });

    const sorted = [...events].sort((a, b) => b.seq - a.seq);
    const groups = groupRows(sorted);

    return (
        <div className="timeline-log">
            <div className="timeline-toolbar">
                <h2>Timeline</h2>
                <label className="autoscroll-toggle">
                    <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
                    자동 스크롤 고정
                </label>
            </div>
            <div className="timeline-list" ref={listRef}>
                {groups.length === 0 && <p className="empty">이벤트가 없습니다.</p>}
                {groups.map(group => {
                    if (group.items.length < COLLAPSE_THRESHOLD) {
                        return group.items.map(event => <EventRow key={event.seq} event={event} />);
                    }
                    const isOpen = expanded.has(group.key);
                    const head = group.items[0];
                    const label = KIND_SUMMARY[group.kind] ?? group.kind;
                    const summary = groupSummary(group);
                    const shortTid = group.tid ? `${group.tid.slice(0, 8)}…` : '';
                    return (
                        <div key={group.key} className="timeline-group">
                            <div
                                className={`timeline-row timeline-group-head ${KIND_HINT_CLASS[group.kind] ?? ''}`}
                                onClick={() => toggle(group.key)}
                                title={group.tid}
                            >
                                <span className="col-seq">{isOpen ? '▾' : '▸'}</span>
                                <span className="col-time">{formatTime(head.at)}</span>
                                <span
                                    className="col-conn"
                                    style={{ backgroundColor: connectionColor(head.connectionId) }}
                                >
                                    {head.connectionId}
                                </span>
                                <span className="col-direction">{DIRECTION_ARROW[head.direction]}</span>
                                <span className="col-kind">{group.kind}</span>
                                <span className="col-detail">
                                    {label} <strong>×{group.items.length}</strong>
                                    {summary && <span className="group-summary"> {summary}</span>}
                                    {shortTid && <span className="group-tid">· {shortTid}</span>}
                                </span>
                            </div>
                            {isOpen && group.items.map(event => <EventRow key={event.seq} event={event} child />)}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default TimelineLog;
