/** single connection/panel control surface: status, condition sliders, payload send/post/ping, lifecycle buttons (03-plan task 7) */
import { useEffect, useRef, useState } from 'react';
import type { ConnectionState, VerifierCondition, VerifierSession } from './types';
import type { VerifierStore } from './verifier-store';
import type { WsVerifierSession } from './ws-session';
import { createMultiSession, type MultiSession } from './multi-session';
import { connectionColor } from './TimelineLog';

interface ConnectionPanelProps {
    connection: ConnectionState;
    session: VerifierSession;
    store: VerifierStore;
    /** mode 'ws' real WebSocket url; also the S0 row's display url and the default for "+ Add Socket" */
    url: string;
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

const ConnectionPanel = ({ connection, session, store, url, onRemove }: ConnectionPanelProps) => {
    const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
    const [newSocketUrl, setNewSocketUrl] = useState(url);
    const [socketPending, setSocketPending] = useState(false);
    const { condition, mode } = connection;
    const wsSession = mode === 'ws' ? (session as WsVerifierSession) : undefined;
    const multiSessionRef = useRef<MultiSession | null>(null);
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            multiSessionRef.current?.detach();
            multiSessionRef.current = null;
        };
    }, []);

    /** attach the Sockets-section session once the panel's main socket is open (no manual toggle) */
    useEffect(() => {
        if (!wsSession || connection.status !== 'open' || multiSessionRef.current) return;
        const primary = wsSession.getPrimaryNetwork();
        if (!primary) return;
        multiSessionRef.current = createMultiSession({ id: connection.id, store, primary, mainUrl: url });
    }, [wsSession, connection.status]);

    const notifyFailure = (action: string, error: unknown) => {
        store.pushEvent({
            connectionId: connection.id,
            direction: 'sys',
            kind: 'error',
            severity: 'error',
            detail: `${action} failed: ${(error as any)?.message ?? error}`,
        });
    };

    const teardownMulti = () => {
        multiSessionRef.current?.detach();
        multiSessionRef.current = null;
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
            teardownMulti();
            session.close();
        } catch (error) {
            notifyFailure('close', error);
        }
    };

    const handleReconnect = async () => {
        try {
            teardownMulti(); // S0 is about to be torn down/recreated - the multi composite would go stale
            await session.reconnect();
        } catch (error) {
            notifyFailure('reconnect', error);
        }
    };

    const handleAddSocket = async () => {
        if (!multiSessionRef.current) return;
        setSocketPending(true);
        try {
            await multiSessionRef.current.addSocket(newSocketUrl || url);
        } catch (error) {
            notifyFailure('addSocket', error);
        } finally {
            if (isMountedRef.current) setSocketPending(false);
        }
    };

    const handleRemoveSocket = (index: number) => {
        try {
            multiSessionRef.current?.removeSocket(index);
        } catch (error) {
            notifyFailure(`removeSocket(S${index})`, error);
        }
    };

    const handleCloseSocket = (index: number) => {
        try {
            multiSessionRef.current?.closeSocket(index);
        } catch (error) {
            notifyFailure(`closeSocket(S${index})`, error);
        }
    };

    const handleSendOne = (index: number) => {
        try {
            multiSessionRef.current?.sendOne(index, parsePayload(payloadText));
        } catch (error) {
            notifyFailure(`sendOne(S${index})`, error);
        }
    };

    const handleSendAll = () => {
        try {
            multiSessionRef.current?.sendAll(parsePayload(payloadText));
        } catch (error) {
            notifyFailure('sendAll', error);
        }
    };

    const backupCount = (connection.sockets?.length ?? 1) - 1;

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

            {mode === 'ws' && (
                <div className="sockets-section">
                    <div className="sockets-header">Sockets</div>
                    {(connection.sockets ?? []).map(row => (
                        <div key={row.index} className="socket-row">
                            <span className="socket-chip">S{row.index}</span>
                            <span className="socket-url" title={row.url}>
                                {row.url}
                            </span>
                            <span className={`status-badge status-${row.status}`}>{row.status}</span>
                            <button onClick={() => handleSendOne(row.index)}>Send</button>
                            <button onClick={() => handleCloseSocket(row.index)}>Close</button>
                            {row.index > 0 && <button onClick={() => handleRemoveSocket(row.index)}>Remove</button>}
                        </div>
                    ))}
                    <div className="socket-add-row">
                        <input
                            type="text"
                            value={newSocketUrl}
                            disabled={socketPending}
                            onChange={e => setNewSocketUrl(e.target.value)}
                            placeholder="새 소켓 url (기본: 메인과 동일)"
                        />
                        <button onClick={handleAddSocket} disabled={socketPending}>
                            + Add Socket
                        </button>
                    </div>
                </div>
            )}

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
                {mode === 'ws' && (
                    <button onClick={handleSendAll} disabled={backupCount < 1}>
                        Send All
                    </button>
                )}
                <button onClick={handleClose} disabled={socketPending}>
                    Close
                </button>
                <button onClick={handleReconnect} disabled={socketPending}>
                    Reconnect
                </button>
            </div>
        </div>
    );
};

export default ConnectionPanel;
