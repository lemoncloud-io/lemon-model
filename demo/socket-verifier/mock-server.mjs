import { WebSocketServer, WebSocket } from 'ws';

/**
 * starts the verifier mock ws server: connect frame -> connectionId (no echo/relay), other text -> echo+relay,
 * binary ignored. connect frame accepts an opt-in `unicast: true` field (reliable-chunk-transport 03-plan 7단계) -
 * such a connection is excluded from receiving its own broadcast (self-echo), while relay to every other
 * connected client is unaffected. default (no flag) keeps the original send-to-everyone-including-self behavior.
 */
export const startMockServer = ({ host = '127.0.0.1', port = 0 } = {}) => {
  const wss = new WebSocketServer({ host, port });
  let seq = 0;

  wss.on('connection', ws => {
    console.log('[mock] connected');
    ws.unicast = false;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (parsed && parsed.action === 'connect') {
        seq += 1;
        const connectionId = `conn-${Date.now().toString(36)}-${seq}`;
        ws.unicast = parsed.unicast === true;
        ws.send(JSON.stringify({ connectionId }));
        return;
      }

      wss.clients.forEach(client => {
        if (client === ws && ws.unicast) return;
        if (client.readyState === WebSocket.OPEN) client.send(text);
      });
    });

    ws.on('close', () => console.log('[mock] disconnected'));
  });

  return wss;
};

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const host = process.env.DEMO_WS_HOST || '127.0.0.1';
  const port = Number(process.env.DEMO_WS_PORT || 8788);
  const wss = startMockServer({ host, port });
  wss.on('listening', () => console.log(`[mock] listening on ws://${host}:${port}`));
}
