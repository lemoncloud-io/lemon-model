/**
 * `playground.js`
 * - sync playground assembly: tap / serverBand / judge / axis / clients / presets / render (06-playground.md 구현 구조).
 * - observes ONLY public lemon-model contracts: onChange, wire envelopes, adapter pure functions.
 * - N clients: simulator clients share ONE logical server band (events broadcast to every bridge);
 *   a real-socket client (URL) is observation-only — the server band cannot reach it.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { createSocketClient, createSyncMachine, createSyncTicker } from '../../dist/esm/sync/index.js';
import { createOwnedWebSocketNetwork } from '../../dist/esm/socket/index.js';
import { createPeerBridge } from '../../dist/esm/sync/testing.js';

const TYPE = 'task';
const TYPE_PULL = `sync/${TYPE}:pull`;
const TYPE_EVENT = `sync/${TYPE}:updated`;
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
const byteLength = value => new TextEncoder().encode(value).length;

// ---------------------------------------------------------------- state

const state = {
    axis: 'seq', // 'updatedAt' | 'seq'
    clients: [], // client instances (sim bridges + optional real sockets)
    clientSeq: 0,
    serverModels: [], // the ONE logical server band's source of truth (starts empty — add models yourself)
    pageSize: 1,
    failNextPull: false,
    hangNextPull: false, // no-reply injection: L3 request timeout observation
    startedAt: Date.now(), // wire log relative clock (ticker backoff observation)
    eventSeq: 0,
    ticker: null,
    presetRunning: false,
};

// ---------------------------------------------------------------- axis (adapters)

/** two adapters over the same wire types — the seq axis injects versionOf, the updatedAt axis exercises the default */
const AXES = {
    updatedAt: {
        field: 'updatedAt',
        versionOf: model => model.updatedAt, // mirror of the machine's default, used by the judge only
        sample: () => [
            { id: 'doc-a', updatedAt: 100, percent: 10 },
            { id: 'doc-b', updatedAt: 200, percent: 80 },
        ],
    },
    seq: {
        field: 'seq',
        versionOf: model => model.seq,
        sample: () => [
            { id: 'doc-a', seq: 3, percent: 10 },
            { id: 'doc-b', seq: 7, percent: 80 },
        ],
    },
};
const axis = () => AXES[state.axis];
const makeAdapter = () => ({
    ...(state.axis === 'seq' ? { versionOf: model => model.seq } : {}),
    buildPull: (since, cursor) => ({ type: TYPE_PULL, data: { since, cursor } }),
    parseReply: data => ({ models: data?.models ?? [], next: data?.next }),
    parseEvent: message => (message.type === TYPE_EVENT ? message.data : undefined),
});

// ---------------------------------------------------------------- server band (one logical server over N sim bridges)

/** attach the pull handler to a sim bridge — every sim client sees the SAME state.serverModels */
function attachServerBand(bridge) {
    bridge.server.onMessage(message => {
        if (message.type !== TYPE_PULL) throw new Error(`@type[${message.type}] unhandled - playground.serverBand`);
        if (state.failNextPull) {
            setFault('failNextPull', false);
            bridge.server.post(
                { type: 'error', data: { message: 'pull failed' }, mid: message.mid },
                { clientId: bridge.clientId },
            );
            //! error was posted manually; throwing suppresses Peer.dispatch's automatic `result` reply (spec idiom).
            throw new Error(`@type[${message.type}] replied manually - playground.serverBand`);
        }
        if (state.hangNextPull) {
            setFault('hangNextPull', false);
            //! throw WITHOUT posting anything = no reply at all → the L3 request times out.
            throw new Error(`@type[${message.type}] no reply (timeout simulation) - playground.serverBand`);
        }
        const since = message.data?.since ?? 0;
        const cursor = message.data?.cursor ?? 0;
        const field = axis().field;
        const matching = state.serverModels.filter(model => (model[field] ?? 0) > since);
        const page = matching.slice(cursor, cursor + state.pageSize);
        const next = cursor + state.pageSize < matching.length ? cursor + state.pageSize : undefined;
        return { models: page, next };
    });
}

const simClients = () => state.clients.filter(instance => instance.kind === 'sim');

const srv = {
    set(models) {
        state.serverModels = models;
        renderServer();
    },
    /** broadcast a server event to every sim client (the real-socket client is out of reach by design) */
    event(models) {
        const mid = `evt-${++state.eventSeq}`;
        for (const instance of simClients()) {
            instance.bridge.server.post(
                { type: TYPE_EVENT, data: models, mid },
                { clientId: instance.bridge.clientId },
            );
        }
    },
    /** raw non-sync event (unowned by the task adapter) */
    foreign(type, data) {
        const mid = `evt-${++state.eventSeq}`;
        for (const instance of simClients()) {
            instance.bridge.server.post({ type, data, mid }, { clientId: instance.bridge.clientId });
        }
    },
    /** delete: bump version, broadcast tombstone, drop from the server table */
    tombstone(id, withVersion = true) {
        const field = axis().field;
        const model = state.serverModels.find(entry => entry.id === id);
        const version = (model?.[field] ?? 0) + 1;
        const tomb = withVersion ? { id, [field]: version, deletedAt: Date.now() } : { id, deletedAt: Date.now() };
        if (withVersion) {
            state.serverModels = state.serverModels.filter(entry => entry.id !== id);
            renderServer();
        }
        srv.event([tomb]);
    },
};

// ---------------------------------------------------------------- judge (adapter re-run inference, per client)

/** envelope types the machine never treats as a domain event (mirror of the machine's dispatch rule) */
const NON_EVENT_TYPES = new Set(['result', 'error', 'ping', 'pong']);

function judgeInbound(instance, raw) {
    let message;
    try {
        message = JSON.parse(raw);
    } catch {
        return;
    }
    if (typeof message?.type !== 'string') return;
    if (NON_EVENT_TYPES.has(message.type)) {
        if (message.type === 'error' && instance.pullMids.has(message.mid)) {
            instance.ui.errLine.textContent = `pull() reject — "${message.data?.message ?? 'error'}" (${
                message.mid
            }) · 스토어·워터마크 무변화`;
        }
        if (message.type === 'result' && instance.pullMids.has(message.mid)) instance.lastPullMid = message.mid;
        return;
    }
    if (!instance.judgeAdapter || !instance.handle) return;
    const models = instance.judgeAdapter.parseEvent(message);
    if (models === undefined) {
        pushJudge(instance, 'skip', '—', message.mid, `미소유 이벤트 (${message.type})`);
        return;
    }
    const versionOf = axis().versionOf;
    for (const incoming of models) {
        if (incoming?.id == null) {
            pushJudge(instance, 'skip', '—', message.mid, 'id 없음');
            continue;
        }
        const version = versionOf(incoming);
        if (version == null) {
            pushJudge(
                instance,
                'skip',
                incoming.id,
                message.mid,
                `축값 없음: versionOf → undefined${incoming.deletedAt ? ' (tombstone) — 삭제 미반영' : ''}`,
            );
            continue;
        }
        const local = instance.handle.get(incoming.id); // pre-apply (tap subscription runs before L3's)
        const localVersion = local ? versionOf(local) : undefined;
        if (!local && incoming.deletedAt) {
            pushJudge(instance, 'skip', incoming.id, message.mid, 'tombstone — 로컬에 없는 모델');
            continue;
        }
        if (local && localVersion != null && version <= localVersion) {
            pushJudge(instance, 'skip', incoming.id, message.mid, `stale: incoming ${version} ≤ local ${localVersion}`);
            continue;
        }
        const action = incoming.deletedAt ? '반영(삭제)' : '반영';
        pushJudge(
            instance,
            'ok',
            incoming.id,
            message.mid,
            `event · ${axis().field} ${version} > ${localVersion ?? '(로컬 없음)'} — ${action}`,
        );
    }
}

// ---------------------------------------------------------------- clients (sim bridge / real socket instances)

/** create a client instance: sim → shared server band bridge, ws → observation-only real socket */
function addClient(kind, url) {
    const label = `c${++state.clientSeq}`;
    let network;
    let bridge;
    if (kind === 'sim') {
        bridge = createPeerBridge();
        attachServerBand(bridge);
        network = bridge.network;
    } else {
        try {
            network = createOwnedWebSocketNetwork({ url });
        } catch (error) {
            alert(`실소켓 연결 실패: ${error?.message ?? error}`);
            return;
        }
    }

    const instance = {
        label,
        kind,
        url,
        bridge,
        watermark: 0,
        wmHistory: [],
        pullMids: new Set(),
        lastPullMid: null,
        judgeAdapter: null,
        handle: null,
        unsubscribe: null,
        ui: null,
    };

    //! L1 tap: our subscription is registered BEFORE the L3 client subscribes —
    //! the network delivers in insertion order, so the judge reads the store pre-apply.
    network.onMessage(raw => {
        logWire(instance, 'down', raw);
        judgeInbound(instance, raw);
    });
    const tapped = {
        get readyState() {
            return network.readyState;
        },
        ready: () => network.ready?.() ?? Promise.resolve(),
        send: raw => {
            logWire(instance, 'up', raw);
            network.send(raw);
        },
        onMessage: handler => network.onMessage(handler),
        onError: handler => network.onError(handler),
        close: (code, reason) => network.close(code, reason),
    };
    instance.network = network;
    instance.client = createSocketClient(tapped, { timeoutMs: 5_000 }); // demo policy: short timeout so no-reply is observable
    instance.machine = createSyncMachine(instance.client);
    instance.client.onError(error => {
        if (instance.ui) instance.ui.errLine.textContent = `onError — ${error?.message ?? error}`;
    });

    instance.ui = buildClientCard(instance);
    state.clients.push(instance);
    registerHandle(instance);
    return instance;
}

function registerHandle(instance) {
    instance.judgeAdapter = makeAdapter(); // judge re-runs its OWN adapter instance (pure/total contract)
    instance.handle = instance.machine.register(TYPE, { adapter: makeAdapter(), initialPull: false });
    instance.unsubscribe = instance.handle.onChange(event => {
        if (event.cause === 'pull') {
            const versionOf = axis().versionOf;
            const max = Math.max(...event.models.map(model => versionOf(model) ?? 0));
            instance.watermark = Math.max(instance.watermark, max);
            instance.wmHistory.push({ value: instance.watermark, mid: instance.lastPullMid ?? '?' });
            const ids = event.models.map(model => model.id).join(', ');
            pushJudge(
                instance,
                'ok',
                ids,
                instance.lastPullMid ?? '—',
                `pull p${instance.wmHistory.length} · → 워터마크 ${instance.watermark}`,
            );
        }
        renderStore(
            instance,
            event.models.map(model => model.id),
        );
        renderWatermark(instance);
    });
}

/** axis toggle: per client handle.close() (NOT machine.close()) → re-register → resubscribe → local reset (05 계약) */
function resetInstance(instance) {
    instance.unsubscribe?.();
    instance.handle?.close();
    instance.watermark = 0;
    instance.wmHistory = [];
    instance.pullMids.clear();
    instance.lastPullMid = null;
    instance.ui.judgeLog.replaceChildren();
    instance.ui.errLine.textContent = '';
    registerHandle(instance);
    renderStore(instance);
    renderWatermark(instance);
}

function removeClient(instance) {
    instance.unsubscribe?.();
    instance.handle?.close();
    instance.machine.close();
    instance.client.close();
    instance.network.close();
    state.clients = state.clients.filter(entry => entry !== instance);
    instance.ui.card.remove();
}

function switchAxis(nextAxis) {
    if (state.ticker) {
        state.ticker.stop();
        state.ticker = null;
        syncTickerSeg(0);
    }
    state.axis = nextAxis;
    setFault('failNextPull', false);
    setFault('hangNextPull', false);
    state.startedAt = Date.now();
    el.wireLog.replaceChildren();
    srv.set([]);
    for (const instance of state.clients) resetInstance(instance);
    renderAxis();
}

// ---------------------------------------------------------------- render

const el = Object.fromEntries(
    [
        'axisSeg',
        'pendingChip',
        'tickBtn',
        'tickerSeg',
        'presetStrip',
        'srvBody',
        'srvVerTh',
        'newIdInput',
        'newVerInput',
        'addModelBtn',
        'tombNoVerBtn',
        'failToggle',
        'hangToggle',
        'pageSizeInput',
        'wireLog',
        'addClientBtn',
        'wsUrlInput',
        'addWsBtn',
        'clientList',
        'themeBtn',
    ].map(id => [id, document.getElementById(id)]),
);

/** fault toggles are buttons: state + .toggle-on class stay in sync */
function setFault(key, on) {
    state[key] = on;
    const button = key === 'failNextPull' ? el.failToggle : el.hangToggle;
    button.classList.toggle('toggle-on', on);
}

const MAX_LOG = 200;

/** per-client card DOM (fixed structure the CSS styles; see index.html .client-card) */
function buildClientCard(instance) {
    const card = document.createElement('div');
    card.className = 'client-card';
    card.innerHTML = `
      <div class="cc-head">
        <b>${instance.label}</b>
        <span class="chip">${instance.kind === 'sim' ? 'simulator' : `실소켓 · 관찰 전용`}</span>
        <span class="chip pending cc-pending">pending 0</span>
        <span class="spacer"></span>
        <button class="btn small cc-pull">pull</button>
        <button class="btn small cc-close" title="close">×</button>
      </div>
      ${
          instance.kind === 'ws'
              ? `<div class="footnote">${instance.url} — 서버 대역 조작이 닿지 않는 외부 서버</div>`
              : ''
      }
      <div class="wm">
        <div class="cur"><b class="cc-wm">0</b><span class="cc-wmlabel"></span></div>
        <div class="hist cc-wmhist"></div>
      </div>
      <div class="table-wrap">
        <table><thead><tr><th>store</th><th class="num cc-verth"></th><th class="num">percent</th></tr></thead>
        <tbody class="cc-store"></tbody></table>
      </div>
      <div class="judge cc-judge"></div>
      <div class="errline cc-err"></div>`;
    el.clientList.append(card);
    const ui = {
        card,
        pending: card.querySelector('.cc-pending'),
        wmCur: card.querySelector('.cc-wm'),
        wmLabel: card.querySelector('.cc-wmlabel'),
        wmHist: card.querySelector('.cc-wmhist'),
        verTh: card.querySelector('.cc-verth'),
        storeBody: card.querySelector('.cc-store'),
        judgeLog: card.querySelector('.cc-judge'),
        errLine: card.querySelector('.cc-err'),
    };
    card.querySelector('.cc-pull').addEventListener('click', () => instance.handle?.pull().catch(() => undefined));
    card.querySelector('.cc-close').addEventListener('click', () => removeClient(instance));
    return ui;
}

function logWire(instance, dir, raw) {
    let message;
    try {
        message = JSON.parse(raw);
    } catch {
        message = { type: '(raw)', data: raw };
    }
    if (dir === 'up' && message.type === TYPE_PULL) instance.pullMids.add(message.mid);

    const row = document.createElement('div');
    row.className = `wire-row${instance.pullMids.has(message.mid) && dir === 'down' ? ' paired' : ''}${
        message.type === 'error' ? ' err' : ''
    }`;
    const cell = (tag, cls, text) => {
        const node = document.createElement(tag);
        node.className = cls;
        node.textContent = text;
        return node;
    };
    const typeClass =
        message.type === TYPE_PULL
            ? ' t-pull'
            : message.type === 'result'
            ? ' t-result'
            : message.type === 'error'
            ? ' t-error'
            : message.type === TYPE_EVENT
            ? ' t-event'
            : '';

    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.append(cell('div', `dir ${dir}`, dir === 'up' ? '↑' : '↓'));

    const l1 = document.createElement('div');
    l1.className = 'l1';
    l1.append(
        cell('span', 'cli', instance.label),
        cell('span', 'ts', `+${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`),
        cell('span', `ty${typeClass}`, message.type),
        cell('span', 'mid', message.mid ?? ''),
    );
    if (message.type === TYPE_PULL) l1.append(cell('mark', 'since', `since ${message.data?.since}`));

    const l2 = document.createElement('div');
    l2.className = 'l2';
    const payText =
        message.type === TYPE_PULL
            ? message.data?.cursor !== undefined
                ? `{ cursor: ${message.data.cursor} }`
                : ''
            : JSON.stringify(message.data ?? '').slice(0, 80);
    l2.append(cell('span', 'pay', payText), cell('span', 'sz', `${byteLength(raw)} B`));

    const body = document.createElement('div');
    body.className = 'body';
    body.append(l1, l2);
    row.append(rail, body);
    el.wireLog.prepend(row);
    while (el.wireLog.children.length > MAX_LOG) el.wireLog.lastChild.remove();
    renderPending();
}

function pushJudge(instance, kind, id, mid, why) {
    const row = document.createElement('div');
    row.className = `judge-row ${kind}`;
    const cell = (cls, text) => {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        return span;
    };
    const jbody = document.createElement('div');
    jbody.className = 'jbody';
    const l1 = document.createElement('div');
    l1.className = 'l1';
    l1.append(cell('id', id), cell('src', mid ? `← ${mid}` : ''));
    const whyEl = document.createElement('div');
    whyEl.className = 'why';
    whyEl.textContent = why;
    jbody.append(l1, whyEl);
    row.append(cell('verdict', kind === 'ok' ? '반영' : kind === 'skip' ? '무시' : 'info'), jbody);
    instance.ui.judgeLog.prepend(row);
    while (instance.ui.judgeLog.children.length > MAX_LOG) instance.ui.judgeLog.lastChild.remove();
}

/** preset narration goes to the FIRST sim client's judge log (presets drive that client) */
const info = text => {
    const primary = simClients()[0];
    if (primary) pushJudge(primary, 'info', '—', 'preset', text);
};

function renderServer() {
    const field = axis().field;
    el.srvVerTh.textContent = field;
    el.newVerInput.placeholder = field;
    el.srvBody.replaceChildren(
        ...state.serverModels.map(model => {
            const tr = document.createElement('tr');
            const idTd = document.createElement('td');
            idTd.textContent = model.id;
            const verTd = document.createElement('td');
            verTd.className = 'num';
            const verInput = document.createElement('input');
            verInput.type = 'number';
            verInput.value = model[field] ?? '';
            verInput.addEventListener('change', () => {
                model[field] = Number(verInput.value);
            });
            verTd.append(verInput);
            const pctTd = document.createElement('td');
            pctTd.className = 'num';
            const pctInput = document.createElement('input');
            pctInput.type = 'number';
            pctInput.value = model.percent ?? '';
            pctInput.addEventListener('change', () => {
                model.percent = Number(pctInput.value);
            });
            pctTd.append(pctInput);
            const actTd = document.createElement('td');
            actTd.className = 'num';
            const sendBtn = document.createElement('button');
            sendBtn.className = 'btn small';
            sendBtn.textContent = '전송';
            sendBtn.addEventListener('click', () => srv.event([{ ...model }]));
            const tombBtn = document.createElement('button');
            tombBtn.className = 'btn small danger';
            tombBtn.textContent = 'tombstone';
            tombBtn.addEventListener('click', () => srv.tombstone(model.id, true));
            actTd.append(sendBtn, ' ', tombBtn);
            tr.append(idTd, verTd, pctTd, actTd);
            return tr;
        }),
    );
}

function renderStore(instance, appliedIds = []) {
    const field = axis().field;
    instance.ui.verTh.textContent = field;
    const models = instance.handle?.list() ?? [];
    instance.ui.storeBody.replaceChildren(
        ...models.map(model => {
            const tr = document.createElement('tr');
            if (appliedIds.includes(model.id)) tr.className = 'applied';
            const cell = (text, num) => {
                const td = document.createElement('td');
                if (num) td.className = 'num';
                td.textContent = text;
                return td;
            };
            tr.append(
                cell(model.id),
                cell(String(model[field] ?? '—'), true),
                cell(String(model.percent ?? '—'), true),
            );
            return tr;
        }),
    );
}

function renderWatermark(instance) {
    instance.ui.wmCur.textContent = String(instance.watermark);
    instance.ui.wmLabel.textContent = `워터마크 (${axis().field} 축) — pull 반영분만 전진, 이벤트는 미전진`;
    const chip = (value, mid) => {
        const step = document.createElement('div');
        step.className = 'step';
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = String(value);
        const m = document.createElement('span');
        m.className = 'm';
        m.textContent = mid;
        step.append(v, m);
        return step;
    };
    instance.ui.wmHist.replaceChildren(chip(0, 'init'));
    for (const step of instance.wmHistory) {
        instance.ui.wmHist.append('→', chip(step.value, step.mid));
    }
}

function renderAxis() {
    for (const button of el.axisSeg.querySelectorAll('button')) {
        button.classList.toggle('on', button.dataset.axis === state.axis);
    }
    renderServer();
}

function renderPending() {
    let total = 0;
    for (const instance of state.clients) {
        const count = instance.client.pendingCount;
        total += count;
        instance.ui.pending.textContent = `pending ${count}`;
    }
    el.pendingChip.textContent = `pending ${total}`;
}

function syncTickerSeg(activeMs) {
    for (const button of el.tickerSeg.querySelectorAll('button')) {
        button.classList.toggle('on', Number(button.dataset.ms) === activeMs);
    }
}

// ---------------------------------------------------------------- presets (server-band sequences over the FIRST sim client)

const tickAll = () => Promise.all(state.clients.map(instance => instance.machine.tick()));
const primaryPull = () =>
    simClients()[0]
        ?.handle.pull()
        .catch(() => undefined) ?? Promise.resolve();

const PRESETS = {
    async e2e() {
        switchAxis(state.axis);
        srv.set(axis().sample());
        info('01#1 ① 최초 pull — since undefined, 커서 페이지 루프');
        await primaryPull();
        await wait();
        info('01#1 ② 서버 이벤트 → 모든 sim 클라이언트에 broadcast·반영');
        const field = axis().field;
        const first = state.serverModels[0];
        first[field] += 10;
        first.percent = 55;
        renderServer();
        srv.event([{ ...first }]);
        await wait();
        info('01#1 ③ 전체 tick — 각 클라이언트가 자기 워터마크 이후 변경분만');
        await tickAll();
        await wait();
        info('01#1 ⑤ tombstone → 스토어 제거');
        srv.tombstone(state.serverModels[1]?.id ?? first.id, true);
        await wait();
    },
    async judgement() {
        switchAxis(state.axis);
        srv.set(axis().sample());
        await primaryPull();
        await wait();
        const field = axis().field;
        const target = simClients()[0]?.handle.list()[0];
        if (!target) return;
        //! 낮은/같은 버전 이벤트는 지연·중복 패킷 시뮬레이션 — 서버 테이블은 그대로가 맞다.
        info('01#2 낮은 버전 → 무시 (지연 도착 패킷)');
        srv.event([{ id: target.id, [field]: target[field] - 1, percent: 1 }]);
        await wait();
        info('01#2 같은 버전 → 무시 (중복 수신, 동치 한계)');
        srv.event([{ id: target.id, [field]: target[field], percent: 2 }]);
        await wait();
        info('01#2 높은 버전 → 반영 (실제 서버 변경 — 서버 테이블도 갱신)');
        const serverEntry = state.serverModels.find(entry => entry.id === target.id);
        if (serverEntry) {
            serverEntry[field] = target[field] + 5;
            serverEntry.percent = 99;
            renderServer();
        }
        srv.event([{ id: target.id, [field]: target[field] + 5, percent: 99 }]);
        await wait();
        info('01#2 미소유 type → parseEvent undefined');
        srv.foreign('chat:message', { room: 'r1', text: 'hello' });
        await wait();
    },
    async pullError() {
        switchAxis(state.axis);
        srv.set(axis().sample());
        await primaryPull();
        await wait();
        info('01#3 다음 pull에 error 응답 — reject, 스토어·워터마크 무변화');
        setFault('failNextPull', true);
        await primaryPull();
        await wait();
        info('01#3 재pull — 같은 워터마크에서 복구');
        await primaryPull();
        await wait();
        info('01#3 tick 재진입 — 동시 tick 2회, pull 요청은 1개 (pending 배지 관찰)');
        const machine = simClients()[0]?.machine;
        if (machine) await Promise.all([machine.tick(), machine.tick()]);
        await wait();
    },
    async seqAxis() {
        switchAxis('seq');
        srv.set(axis().sample());
        info('05#2 seq 축 — updatedAt 없는 대상, versionOf 주입');
        await primaryPull();
        await wait();
        info('05#2 재tick — since = pull 반영분 max(seq)');
        await tickAll();
        await wait();
    },
    async undefinedVersion() {
        switchAxis(state.axis);
        srv.set(axis().sample());
        await primaryPull();
        await wait();
        info('05#3 축값 없는 수신 모델 → versionOf undefined → 무시');
        const target = simClients()[0]?.handle.list()[0];
        if (target) srv.event([{ id: target.id, percent: 42 }]);
        await wait();
        info('05#3 local-undefined 절반은 spec 전용 (private store 시딩)');
    },
    async safetyNet() {
        switchAxis('seq');
        srv.set(axis().sample());
        await primaryPull();
        await wait();
        info('05#4 높은 seq 이벤트 반영 — 워터마크는 유지');
        srv.set([...state.serverModels, { id: 'doc-x', seq: 50, percent: 10 }]);
        srv.event([{ id: 'doc-x', seq: 50, percent: 10 }]);
        await wait();
        info('05#4 tick — since가 이벤트 seq(50)가 아니라 pull 반영분 max임을 wire에서 확인');
        await tickAll();
        await wait();
    },
    async tombstone() {
        switchAxis('seq');
        srv.set(axis().sample());
        await primaryPull();
        await wait();
        info('05#5 축값 실은 tombstone → 판정 통과, 스토어 제거');
        srv.tombstone('doc-a', true);
        await wait();
        info('05#5 축값 누락 tombstone → 무시, 삭제 미반영 (서버 계약 전제 3)');
        srv.tombstone('doc-b', false);
        await wait();
    },
};

// ---------------------------------------------------------------- ui wiring + boot

el.axisSeg.addEventListener('click', event => {
    const nextAxis = event.target.dataset?.axis;
    if (nextAxis && nextAxis !== state.axis) switchAxis(nextAxis);
});
el.tickBtn.addEventListener('click', () => tickAll());
el.tickerSeg.addEventListener('click', event => {
    const ms = Number(event.target.dataset?.ms ?? NaN);
    if (Number.isNaN(ms)) return;
    state.ticker?.stop();
    state.ticker = null;
    if (ms > 0) {
        state.ticker = createSyncTicker(() => tickAll(), { intervalMs: ms });
        state.ticker.start();
    }
    syncTickerSeg(ms);
});
el.presetStrip.addEventListener('click', async event => {
    const preset = PRESETS[event.target.dataset?.preset];
    if (!preset || state.presetRunning) return;
    state.presetRunning = true;
    for (const button of el.presetStrip.querySelectorAll('button')) button.disabled = true;
    try {
        await preset();
    } finally {
        state.presetRunning = false;
        for (const button of el.presetStrip.querySelectorAll('button')) button.disabled = false;
    }
});
el.addModelBtn.addEventListener('click', () => {
    const field = axis().field;
    const id = el.newIdInput.value.trim();
    const version = Number(el.newVerInput.value);
    if (!id) return alert('id를 입력하세요');
    if (state.serverModels.some(model => model.id === id)) return alert(`id[${id}]가 이미 있습니다`);
    srv.set([
        ...state.serverModels,
        { id, [field]: Number.isFinite(version) && version > 0 ? version : 1, percent: 0 },
    ]);
    el.newIdInput.value = '';
    el.newVerInput.value = '';
});
el.tombNoVerBtn.addEventListener('click', () => {
    const id = state.serverModels[0]?.id ?? simClients()[0]?.handle.list()[0]?.id;
    if (id) srv.tombstone(id, false);
});
el.failToggle.addEventListener('click', () => setFault('failNextPull', !state.failNextPull));
el.hangToggle.addEventListener('click', () => setFault('hangNextPull', !state.hangNextPull));
el.themeBtn.addEventListener('click', () => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = document.documentElement.dataset.theme ?? (prefersDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    el.themeBtn.textContent = next === 'dark' ? '라이트 모드' : '다크 모드';
});
el.pageSizeInput.addEventListener('change', () => {
    state.pageSize = Math.max(1, Number(el.pageSizeInput.value) || 1);
});
el.addClientBtn.addEventListener('click', () => addClient('sim'));
el.addWsBtn.addEventListener('click', () => {
    const url = el.wsUrlInput.value.trim();
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) return alert('ws:// 또는 wss:// URL을 입력하세요');
    addClient('ws', url);
});

setInterval(renderPending, 300);
addClient('sim');
renderAxis();
