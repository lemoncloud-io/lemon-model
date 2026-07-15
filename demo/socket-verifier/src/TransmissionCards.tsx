/** renders a panel's transmission cards: role, tid, lifecycle chip, and the chunk grid (P0-1/P0-2) */
import type { TransmissionCard } from './transmissions';

const SHORT_TID = (tid: string): string => (tid.length > 8 ? tid.slice(0, 8) : tid);

const STATUS_LABEL: Record<TransmissionCard['status'], string> = {
    sending: '전송중',
    resending: '재전송',
    nack: 'NACK 복구중',
    acked: '✅ acked',
    assembled: '✅ assembled',
    failed: '❌ failed',
};

const roleLabel = (card: TransmissionCard): string => (card.role === 'sender' ? '발신 →' : '수신 ←');

const TransmissionCards = ({ cards }: { cards: TransmissionCard[] }) => {
    if (cards.length === 0) return null;
    return (
        <div className="tx-cards">
            <div className="tx-cards-header">전송 단위</div>
            {cards.map(card => {
                const chipStatus =
                    card.status === 'resending' && card.attempt > 0
                        ? `재전송 ${card.attempt}`
                        : STATUS_LABEL[card.status];
                return (
                    <div key={card.tid} className={`tx-card tx-status-${card.status}`}>
                        <div className="tx-card-head">
                            <span className={`tx-role tx-role-${card.role}`}>{roleLabel(card)}</span>
                            <span className="tx-tid" title={card.tid}>
                                {SHORT_TID(card.tid)}
                            </span>
                            <span className={`tx-chip tx-chip-${card.status}`}>{chipStatus}</span>
                        </div>
                        {card.total > 0 ? (
                            <div className="tx-grid">
                                {card.cells.map((cell, index) => (
                                    <span
                                        key={index}
                                        className={`tx-cell tx-cell-${cell.state}${
                                            cell.recovered ? ' tx-cell-recovered' : ''
                                        }`}
                                        title={
                                            cell.recovered
                                                ? `chunk ${index}: dropped → recovered`
                                                : `chunk ${index}: ${cell.state}`
                                        }
                                    >
                                        {index}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <div className="tx-grid tx-grid-inline">inline (분할 없음)</div>
                        )}
                        {(card.dropCount > 0 || card.nackCount > 0 || card.attempt > 0 || card.status === 'acked') && (
                            <div className="tx-card-meta">
                                {card.status === 'acked' && <span className="tx-dir-in">ACK ←</span>}
                                {card.nackCount > 0 && <span className="tx-dir-in">NACK ← {card.nackCount}</span>}
                                {card.attempt > 0 && <span className="tx-dir-out">resend → {card.attempt}</span>}
                                {card.dropCount > 0 && <span>drop {card.dropCount}</span>}
                                {card.total > 0 && <span>chunks {card.total}</span>}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default TransmissionCards;
