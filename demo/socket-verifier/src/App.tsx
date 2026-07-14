/** demo shell: mode toggle + add/remove panels, scenario presets, left panel list + right shared timeline */
import { useRef, useState, useSyncExternalStore } from 'react';
import { createVerifierStore } from './verifier-store';
import { createPeerSession } from './peer-session';
import { createPeerReliableSession } from './peer-reliable-session';
import { createWsSession } from './ws-session';
import { tidOf } from './transmissions';
import { DEFAULT_VERIFIER_CONDITION } from './types';
import type { VerifierSession } from './types';
import type { WsVerifierSession } from './ws-session';
import type { ReliableOptions } from '@socket/transport';
import ConnectionPanel from './ConnectionPanel';
import TimelineLog from './TimelineLog';
import './styles.css';

const store = createVerifierStore();
/** vite injects this at dev-server start (start.cjs); avoided a typed import.meta.env dependency on purpose */
const WS_URL = ((import.meta as any).env?.VITE_DEMO_WS_URL as string | undefined) ?? '';

/** alphabetical panel ids (02-design ID format table) — monotonic, never reused after removal */
let panelCounter = 0;
const nextPanelId = (): string => {
    const id = String.fromCharCode(65 + panelCounter);
    panelCounter += 1;
    return id;
};

/** payload comfortably larger than the default maxPacketBytes so a send splits into several chunks */
const largePayload = (): unknown => ({ big: 'x'.repeat(DEFAULT_VERIFIER_CONDITION.maxPacketBytes + 2048) });
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const App = () => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const sessionsRef = useRef(new Map<string, VerifierSession>());
    const [mode, setMode] = useState<'peer' | 'ws'>('peer');
    const [reliable, setReliable] = useState(false);
    const [scenarioBusy, setScenarioBusy] = useState(false);

    /** create one panel + its session; `reliableOpt` may be an object to tune reliable-mode timing (presets) */
    const spawnPanel = (opts: {
        mode: 'peer' | 'ws';
        reliableOpt?: boolean | ReliableOptions;
    }): {
        id: string;
        session: VerifierSession;
    } => {
        const id = nextPanelId();
        const isWs = opts.mode === 'ws';
        store.addConnection({
            id,
            mode: opts.mode,
            status: 'connecting',
            condition: { ...DEFAULT_VERIFIER_CONDITION },
            pendingCount: 0,
            reliable: isWs ? !!opts.reliableOpt : undefined,
        });
        const session = isWs
            ? createWsSession({ id, url: WS_URL, store, transportOptions: { reliable: opts.reliableOpt } })
            : createPeerSession({ id, store });
        sessionsRef.current.set(id, session);
        session.connect().catch(error => {
            store.pushEvent({
                connectionId: id,
                direction: 'sys',
                kind: 'error',
                severity: 'error',
                detail: `connect failed: ${error?.message ?? error}`,
            });
        });
        return { id, session };
    };

    const addPanel = () => {
        spawnPanel({ mode, reliableOpt: mode === 'ws' ? reliable : undefined });
    };

    const removePanel = (id: string) => {
        sessionsRef.current.get(id)?.close();
        sessionsRef.current.delete(id);
        store.removeConnection(id);
    };

    const clearPanels = () => {
        for (const connection of store.getSnapshot().connections) removePanel(connection.id);
    };

    const waitOpen = async (id: string, timeoutMs = 8000): Promise<void> => {
        const start = Date.now();
        while (store.getSnapshot().connections.find(c => c.id === id)?.status !== 'open') {
            if (Date.now() - start > timeoutMs) throw new Error(`waitOpen timeout: ${id}`);
            await sleep(50);
        }
    };

    /**
     * one-click reliable reproductions (P1-4). Each spins up a fresh sender (A) / receiver (B) pair.
     * The receiver nacks fast; the sender's blind resend is deliberately slow so the NACK path — not
     * blind-resend — is what recovers a partial loss, making it observable in the timeline.
     */
    const runScenario = async (kind: 'normal' | 'nack' | 'fail') => {
        if (scenarioBusy) return;
        setScenarioBusy(true);
        setMode('ws');
        setReliable(true);
        try {
            clearPanels();
            store.clearEvents(); // per-run reset so the summary chips count only this scenario
            await sleep(50);

            const senderOpt: ReliableOptions =
                kind === 'fail'
                    ? { nackDebounceMs: 300, resendIntervalMs: 1000, maxAttempts: 3 }
                    : { nackDebounceMs: 300, resendIntervalMs: 4000, maxAttempts: 8 };
            const receiverOpt: ReliableOptions = { nackDebounceMs: 300 };

            const sender = spawnPanel({ mode: 'ws', reliableOpt: senderOpt });
            const receiver = spawnPanel({ mode: 'ws', reliableOpt: receiverOpt });
            await Promise.all([waitOpen(sender.id), waitOpen(receiver.id)]);
            await sleep(100);

            const senderWs = sender.session as WsVerifierSession;
            if (kind === 'nack') {
                sender.session.configure({ ...DEFAULT_VERIFIER_CONDITION, dropFilter: 'chunk' });
                senderWs.armForceDrop(2);
            } else if (kind === 'fail') {
                sender.session.configure({ ...DEFAULT_VERIFIER_CONDITION, dropFilter: 'chunk', dropRate: 1 });
            }

            // all presets send a chunked payload so the chunk grid is populated (all-green on success)
            await sender.session.send(largePayload()).catch(() => undefined); // fail scenario rejects by design
        } finally {
            setScenarioBusy(false);
        }
    };

    /** Peer(권장 진입점) reliable 왕복 데모: createPeer({ reliable: true }) 쌍의 send→ack→result 를 카드/타임라인에 표시 */
    const runPeerReliable = async () => {
        if (scenarioBusy) return;
        setScenarioBusy(true);
        setMode('peer');
        try {
            clearPanels();
            store.clearEvents();
            await sleep(50);

            const id = nextPanelId();
            store.addConnection({
                id,
                mode: 'peer',
                status: 'connecting',
                condition: { ...DEFAULT_VERIFIER_CONDITION },
                pendingCount: 0,
                reliable: true,
            });
            const session = createPeerReliableSession({ id, store });
            sessionsRef.current.set(id, session);
            await session.connect();
            await waitOpen(id);
            await session.send({ hello: 'reliable peer', at: Date.now() }).catch(() => undefined);
        } finally {
            setScenarioBusy(false);
        }
    };

    /** aggregate the summary chips; failures are counted per logical transmission (tid) so a sender-side
     * `json.reliable.failed` and its receiver-side `json:error` for the same tid stay a single failure */
    const totals = (() => {
        const acc = { sent: 0, acked: 0, resent: 0, failed: 0 };
        const failedTids = new Set<string>();
        let failedUntagged = 0;
        for (const event of snapshot.events) {
            if (event.kind === 'send') acc.sent += 1;
            else if (event.kind === 'ack') acc.acked += 1;
            else if (event.kind === 'resend') acc.resent += 1;
            else if (event.kind === 'reliable-fail' || event.kind === 'expired') {
                const tid = tidOf(event);
                if (tid) failedTids.add(tid);
                // a tid-less `json.error` is the receiver's mirror of the sender's `json.reliable.failed`
                // (same logical transmission) — don't let it double the count
                else if (event.meta?.scope !== 'json.error') failedUntagged += 1;
            }
        }
        acc.failed = failedTids.size + failedUntagged;
        return acc;
    })();

    return (
        <div className="app">
            <header className="toolbar">
                <h1>Socket Visual Verifier</h1>
                <div className="scenario-presets">
                    <span className="preset-label">시나리오</span>
                    <button disabled={scenarioBusy} onClick={() => runScenario('normal')}>
                        정상 전송
                    </button>
                    <button disabled={scenarioBusy} onClick={() => runScenario('nack')}>
                        부분 유실 → NACK 복구
                    </button>
                    <button disabled={scenarioBusy} onClick={() => runScenario('fail')}>
                        전량 유실 → 실패
                    </button>
                    <button
                        disabled={scenarioBusy}
                        onClick={runPeerReliable}
                        title="createPeer({ reliable: true }) 인메모리 왕복"
                    >
                        Peer 왕복 (reliable)
                    </button>
                </div>
                <div className="add-panel">
                    <select value={mode} onChange={e => setMode(e.target.value as 'peer' | 'ws')}>
                        <option value="peer">Mode A · Peer (in-memory)</option>
                        <option value="ws">Mode B · WebSocket</option>
                    </select>
                    <label className={`reliable-toggle${mode !== 'ws' ? ' disabled-field' : ''}`}>
                        <input
                            type="checkbox"
                            checked={reliable}
                            disabled={mode !== 'ws'}
                            onChange={e => setReliable(e.target.checked)}
                        />
                        reliable
                    </label>
                    <button onClick={addPanel}>+ 패널 추가</button>
                </div>
            </header>
            <div className="summary-bar">
                <span className="summary-chip chip-sent">sent {totals.sent}</span>
                <span className="summary-chip chip-acked">acked {totals.acked}</span>
                <span className="summary-chip chip-resent">resent {totals.resent}</span>
                <span className="summary-chip chip-failed">failed {totals.failed}</span>
                <button className="summary-reset" onClick={() => store.clearEvents()} title="타임라인/집계 초기화">
                    리셋
                </button>
            </div>
            <main className="layout">
                <section className="panels">
                    {snapshot.connections.length === 0 && <p className="empty">패널을 추가하세요.</p>}
                    {snapshot.connections.map(connection => (
                        <ConnectionPanel
                            key={connection.id}
                            connection={connection}
                            session={sessionsRef.current.get(connection.id)!}
                            store={store}
                            events={snapshot.events}
                            url={WS_URL}
                            onRemove={() => removePanel(connection.id)}
                        />
                    ))}
                </section>
                <section className="timeline-section">
                    <TimelineLog events={snapshot.events} connections={snapshot.connections} />
                </section>
            </main>
        </div>
    );
};

export default App;
