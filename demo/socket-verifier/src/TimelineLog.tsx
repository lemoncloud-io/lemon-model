/** shared timeline: renders every TimelineEvent newest-first with connection/severity/kind visual cues (02-design.md, 01-spec client sync contract) */
import { useEffect, useRef, useState } from 'react';
import type { ConnectionState, TimelineEvent, TimelineKind } from './types';

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
};

const formatTime = (at: number): string => {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
};

/** renders the full shared timeline, newest event on top */
const TimelineLog = ({ events }: TimelineLogProps) => {
    const [autoScroll, setAutoScroll] = useState(true);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (autoScroll && listRef.current) listRef.current.scrollTop = 0;
    }, [events.length, autoScroll]);

    const sorted = [...events].sort((a, b) => b.seq - a.seq);

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
                {sorted.length === 0 && <p className="empty">이벤트가 없습니다.</p>}
                {sorted.map(event => (
                    <div
                        key={event.seq}
                        className={`timeline-row ${event.severity === 'error' ? 'row-error' : ''} ${KIND_HINT_CLASS[event.kind] ?? ''}`}
                    >
                        <span className="col-seq">#{event.seq}</span>
                        <span className="col-time">{formatTime(event.at)}</span>
                        <span className="col-conn" style={{ backgroundColor: connectionColor(event.connectionId) }}>
                            {event.connectionId}
                        </span>
                        <span className="col-direction">{DIRECTION_ARROW[event.direction]}</span>
                        <span className="col-kind">{event.kind}</span>
                        <span className="col-detail">
                            {typeof event.meta?.socketIndex === 'number' && (
                                <span className="socket-chip">S{event.meta?.socketIndex}</span>
                            )}
                            {event.detail}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default TimelineLog;
