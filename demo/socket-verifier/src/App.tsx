/** demo shell: mode toggle + add/remove panels, left panel list + right shared timeline (03-plan task 7) */
import { useRef, useState, useSyncExternalStore } from 'react';
import { createVerifierStore } from './verifier-store';
import { createPeerSession } from './peer-session';
import { createWsSession } from './ws-session';
import { DEFAULT_VERIFIER_CONDITION } from './types';
import type { VerifierSession } from './types';
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

const App = () => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const sessionsRef = useRef(new Map<string, VerifierSession>());
    const [mode, setMode] = useState<'peer' | 'ws'>('peer');

    const addPanel = () => {
        const id = nextPanelId();
        store.addConnection({
            id,
            mode,
            status: 'connecting',
            condition: { ...DEFAULT_VERIFIER_CONDITION },
            pendingCount: 0,
        });
        const session =
            mode === 'peer' ? createPeerSession({ id, store }) : createWsSession({ id, url: WS_URL, store });
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
    };

    const removePanel = (id: string) => {
        sessionsRef.current.get(id)?.close();
        sessionsRef.current.delete(id);
        store.removeConnection(id);
    };

    return (
        <div className="app">
            <header className="toolbar">
                <h1>Socket Visual Verifier</h1>
                <div className="add-panel">
                    <select value={mode} onChange={e => setMode(e.target.value as 'peer' | 'ws')}>
                        <option value="peer">Mode A · Peer (in-memory)</option>
                        <option value="ws">Mode B · WebSocket</option>
                    </select>
                    <button onClick={addPanel}>+ 패널 추가</button>
                </div>
            </header>
            <main className="layout">
                <section className="panels">
                    {snapshot.connections.length === 0 && <p className="empty">패널을 추가하세요.</p>}
                    {snapshot.connections.map(connection => (
                        <ConnectionPanel
                            key={connection.id}
                            connection={connection}
                            session={sessionsRef.current.get(connection.id)!}
                            store={store}
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
