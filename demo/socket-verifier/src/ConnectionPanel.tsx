/** single connection/panel control surface: status, condition sliders, payload send/post/ping, lifecycle buttons (03-plan task 7) */
import { useState } from 'react';
import type { ConnectionState, VerifierCondition, VerifierSession } from './types';
import type { VerifierStore } from './verifier-store';
import { connectionColor } from './TimelineLog';

interface ConnectionPanelProps {
    connection: ConnectionState;
    session: VerifierSession;
    store: VerifierStore;
    onRemove: () => void;
}

const DEFAULT_PAYLOAD = '{"hello":"world"}';

/** parse the textarea as JSON; fall back to the raw string so any input is sendable */
const parsePayload = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const ConnectionPanel = ({ connection, session, store, onRemove }: ConnectionPanelProps) => {
    const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
    const { condition, mode } = connection;

    const notifyFailure = (action: string, error: unknown) => {
        store.pushEvent({
            connectionId: connection.id,
            direction: 'sys',
            kind: 'error',
            severity: 'error',
            detail: `${action} failed: ${(error as any)?.message ?? error}`,
        });
    };

    const patchCondition = (patch: Partial<VerifierCondition>) => {
        session.configure({ ...condition, ...patch });
    };

    const generateLargePayload = () => {
        const big = 'x'.repeat(condition.maxPacketBytes + 2048);
        setPayloadText(JSON.stringify({ big }));
    };

    const handleSend = async () => {
        try {
            await session.send(parsePayload(payloadText));
        } catch (error) {
            notifyFailure('send', error);
        }
    };

    const handlePost = () => {
        try {
            session.post(parsePayload(payloadText));
        } catch (error) {
            notifyFailure('post', error);
        }
    };

    const handlePing = async () => {
        if (!session.ping) return;
        try {
            await session.ping(parsePayload(payloadText));
        } catch (error) {
            notifyFailure('ping', error);
        }
    };

    const handleClose = () => {
        try {
            session.close();
        } catch (error) {
            notifyFailure('close', error);
        }
    };

    const handleReconnect = async () => {
        try {
            await session.reconnect();
        } catch (error) {
            notifyFailure('reconnect', error);
        }
    };

    return (
        <div className="connection-panel">
            <div className="panel-header">
                <span className="col-conn" style={{ backgroundColor: connectionColor(connection.id) }}>
                    {connection.id}
                </span>
                <span className="mode-label">{mode === 'peer' ? 'Mode A · Peer' : 'Mode B · WS'}</span>
                <span className={`status-badge status-${connection.status}`}>{connection.status}</span>
                <button className="remove-btn" onClick={onRemove} title="패널 제거">
                    ✕
                </button>
            </div>

            {connection.remoteConnectionId && (
                <div className="remote-id">remoteConnectionId: {connection.remoteConnectionId}</div>
            )}
            <div className="pending-count">pending: {connection.pendingCount}</div>

            <fieldset className="condition-fields">
                <legend>조건</legend>
                <label>
                    latencyMs ({condition.latencyMs})
                    <input
                        type="range"
                        min={0}
                        max={2000}
                        step={10}
                        value={condition.latencyMs}
                        onChange={e => patchCondition({ latencyMs: Number(e.target.value) })}
                    />
                </label>
                <label>
                    jitterMs ({condition.jitterMs})
                    <input
                        type="range"
                        min={0}
                        max={500}
                        step={5}
                        value={condition.jitterMs}
                        onChange={e => patchCondition({ jitterMs: Number(e.target.value) })}
                    />
                </label>
                <label className="checkbox-field">
                    <input
                        type="checkbox"
                        checked={condition.unordered}
                        onChange={e => patchCondition({ unordered: e.target.checked })}
                    />
                    unordered
                </label>
                <label>
                    maxPacketBytes
                    <input
                        type="number"
                        min={0}
                        value={condition.maxPacketBytes}
                        onChange={e => patchCondition({ maxPacketBytes: Number(e.target.value) })}
                    />
                </label>
                <label className={mode === 'peer' ? 'disabled-field' : ''}>
                    dropRate ({condition.dropRate.toFixed(2)})
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={mode === 'peer'}
                        value={condition.dropRate}
                        onChange={e => patchCondition({ dropRate: Number(e.target.value) })}
                    />
                </label>
                <label className={mode === 'peer' ? 'disabled-field' : ''}>
                    corruptRate ({condition.corruptRate.toFixed(2)})
                    <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={mode === 'peer'}
                        value={condition.corruptRate}
                        onChange={e => patchCondition({ corruptRate: Number(e.target.value) })}
                    />
                </label>
            </fieldset>

            <div className="payload-field">
                <label htmlFor={`payload-${connection.id}`}>payload (JSON)</label>
                <textarea
                    id={`payload-${connection.id}`}
                    rows={3}
                    value={payloadText}
                    onChange={e => setPayloadText(e.target.value)}
                />
                <button onClick={generateLargePayload}>대용량 생성 (&gt; maxPacketBytes)</button>
            </div>

            <div className="action-buttons">
                <button onClick={handleSend}>Send</button>
                <button onClick={handlePost}>Post</button>
                <button onClick={handlePing} disabled={!session.ping} title={!session.ping ? 'mode ws에는 ping이 없습니다' : ''}>
                    Ping
                </button>
                <button onClick={handleClose}>Close</button>
                <button onClick={handleReconnect}>Reconnect</button>
            </div>
        </div>
    );
};

export default ConnectionPanel;
