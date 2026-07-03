# Network Decorators & Ticker Design

문서 순서: [01-design](./01-design.md) → `05-network-decorators.md`

## 개요

model-sync-client v1은 재연결·레거시 wire 대응·폴링 backoff를 의도적으로 비범위로 남겼음. 
이 문서는 그 세 가지를 채우는 코드 설계를 정의한다.

- `createReconnectingNetwork` — 끊긴 소켓을 스스로 되살리는 L1 network decorator
- `createTranslatedNetwork` — 표준 봉투를 못 쓰는 레거시 서버를 raw 단계에서 번역하는 L1 network decorator
- `createSyncTicker` — tick 소유 지점(서비스)이 선택적으로 쓰는 주기 실행 도구

셋 다 레이어가 아니며, 앞의 둘은 기존 L1 계약(`NetworkSupportable`)을 구현하는 부품이고, ticker는 레이어 밖(서비스 계층)의 도구다. v1의 L3/L4는 한 줄도 바뀌지 않으며, 모든 추가는 additive다.

## 설계 기준

이 트랙의 모든 부품이 따르는 기준이다. 리뷰는 코드가 아니라 이 기준 위반 여부로 한다.

1. 저수준 포지션: lemon-model은 계약과 정책-중립 기계만 제공한다. 정책(주기·인증·도메인 규약·backoff 수치·재연결 조건)은 전부 상위가 주입한다.
2. 레이어 배치: 봉투(mid/type)를 아는 코드는 L3 이상에만, raw string만 아는 코드는 L1에만 둔다. 어떤 부품의 소속이 궁금하면 "무엇을 아는가"로 판정한다.
3. decorator: 기존 계약을 그대로 구현해 갈아 끼운다. 상위 무변경, opt-in, 조합 순서 자유. 합성 순서는 `filtered(translated(reconnecting(factory)))` — 소켓 생성을 소유하는 재연결이 가장 안쪽, stateless 변환이 그 위.
4. 정직한 실패: 실패를 큐잉·재시도로 숨기지 않는다. 끊김 중 발신은 throw이고, 복구는 pull 안전망(tick)의 몫이다.
5. 프로젝트 규칙 반입 금지: chatic 등 특정 프로젝트의 wire 규칙은 lemon-model에 넣지 않는다. 범용 기계 + 주입식 codec/옵션으로만 흡수.
6. 머신은 timer를 갖지 않는다: 주기 실행은 서비스별로 소유. 도구는 제공하되 결합하지 않는다.

## 레이어 위치

| 부품 | 소속 | 근거 (기준 2로 판정) |
| --- | --- | --- |
| `createReconnectingNetwork` | **L1 부품** — `src/socket/decorators.ts` | raw string만 안다. 재연결은 "소켓 수명" 문제이므로 소켓을 소유한 계층의 일이다 |
| `createTranslatedNetwork` | **L1 부품** — `src/socket/decorators.ts` | 응답 settle은 L3 내부에서 일어나므로, 응답 규약 번역은 봉투가 생기기 **이전**(raw)에서만 가능하다. 어댑터(L4 주입)로는 불가능한 자리 |
| `createSyncTicker` | **레이어 아님** — `src/sync/ticker.ts` | tick 주기는 서비스 정책이라는 결정의 보조 도구. 머신과 결합하지 않고 임의 Promise 함수를 받는다 |

decorator가 `src/socket`에 사는 이유: 기존 L1 decorator(`createFilteredNetwork`)의 선례를 따르고, sync를 쓰지 않는 L1 소비자(chatic, proxy)가 일급 사용자이기 때문이다. 상위 계층은 부품을 골라 쌓는다:

```
[App / UI]
[서비스 SDK · chatic client-socket-v2]   ← 정책 계층: 인증, rotation, gateway, tick 주기
[L4 sync machine]                        ← 선택
[L3 socket client]                       ← 선택
[L1 decorators: reconnect·translate·filter] ← 선택 조립 (조합 순서 자유)
[L1 network: Owned/Browser WebSocketNetwork]
[L0 WebSocket]
```

chatic과의 관계: chatic은 자기 runtime(정책)을 유지한 채 L1 부품만 골라 쓸 수 있다. migrate-socket에서 chatic에 남긴 것은 **정책**이고, 여기 추가한 것은 정책을 주입받는 **기계**다 — 모순이 아니라 분업이다. 단계적 적용 경로: ① L1 network(이미 적용) → ② 재연결 기계 위임(rotation은 factory 클로저가 재시도마다 새 토큰 URL을 읽는 것으로 자연 지원) → ③ `:ok`/`:error` codec 번역 후 L3 채택 → ④ plan을 어댑터로 사상해 L4 채택. auth 게이트·keep-alive ping은 chatic 정책 계층에 남는다.

## 1. createReconnectingNetwork — L1 재연결 decorator

인스턴스 identity를 유지한 채 내부 network를 교체한다. L3는 이 decorator 하나만 참조하므로 재연결 전후로 L3/L4 재배선이 없다.

```ts
export interface ReconnectOptions {
    /** 첫 재시도 지연 (기본 1_000ms) */
    baseMs?: number;
    /** 지수 backoff 배수 (기본 2) */
    factor?: number;
    /** 재시도 지연 상한 (기본 30_000ms) */
    maxMs?: number;
    /** 재시도 횟수 상한 (기본 무제한, 초기 연결은 세지 않는다). 도달 시 onError 통지 후 영구 closed */
    maxRetries?: number;
    /** 이 시간 동안 수신이 없으면 stale로 보고 강제 재연결 (기본 off) */
    idleTimeoutMs?: number;
    /** readyState 감시 주기 (기본 1_000ms). 통지 없이 닫히는 network(in-memory 등)용 fallback 감지 */
    watchdogMs?: number;
}

export interface ReconnectingNetworkSupportable extends NetworkSupportable {
    /** 재연결 성공마다 통지 (최초 연결 제외). 서비스는 여기서 machine.tick()으로 따라잡는다 */
    onReconnect(handler: () => void): SocketUnsubscribe;
    /** 내부 network 세대 (최초 0, 재연결마다 +1) */
    readonly generation: number;
}

export const createReconnectingNetwork = (
    factory: () => NetworkSupportable,
    options?: ReconnectOptions,
): ReconnectingNetworkSupportable;
```

의미론 — 내부는 4상태 기계다: `connected`(정상 감시) → `backoff`(재시도 대기) → `connecting`(후보 open 대기) → `connected` 또는 실패 시 `backoff`, 종단은 `closed`.

- 죽음 감지는 두 경로의 결합이다: `OwnedWebSocketNetwork`/`BrowserWebSocketNetwork`의 close onError 통지(`ownedClose`/`browserClose` scope), 그리고 watchdog의 readyState 폴링(통지 없이 닫히는 network용 fallback).
- **재연결 성공 판정은 후보가 실제로 open된 시점이다.** factory 반환만으로는 성공이 아니다 — 실제 WebSocket은 서버가 죽어 있어도 생성은 성공하므로, 반환 시점에 backoff를 리셋하면 고정 주기 재연결 폭주가 된다. open 전에 죽은 후보는 실패로 집계되어 backoff가 계속 증가하고, `onReconnect`도 open 후에만 발화한다. 후보가 connecting에 머무는 시간의 상한은 내부 network의 연결 타임아웃(`OwnedWebSocketNetwork.connectTimeoutMs`) 소관이다.
- 끊긴 동안 `send()`는 동기 throw한다 (기준 4). L3가 이를 request reject로 변환하므로 호출자는 tick 재시도로 복구한다.
- `configure()` 옵션은 기억해 두었다가 재연결된 새 세대에 재적용한다.
- `close()`는 재연결을 중단하고 내부 network를 닫는다. 이후 영구 closed.
- keep-alive(ping 발신)는 봉투 지식이므로 이 레이어에 없다 (기준 2). `idleTimeoutMs`는 수신 부재 기반의 stale 감지만 제공한다.

## 2. createTranslatedNetwork — L1 wire translator

표준 봉투를 쓰지 못하는 레거시 서버를 raw string 단계에서 번역한다.

```ts
export interface WireTranslator {
    /** 발신 raw 변환 (기본 passthrough) */
    outbound?: (raw: string) => string;
    /** 수신 raw 변환. undefined 반환 시 해당 raw를 버린다 (기본 passthrough) */
    inbound?: (raw: string) => string | undefined;
}

export const createTranslatedNetwork = (source: NetworkSupportable, translator: WireTranslator): NetworkSupportable;
```

- chatic `:ok`/`:error` suffix ↔ `result`/`error` 재작성 같은 프로젝트 규칙은 spec의 예제 codec으로만 둔다 (기준 5).
- `inbound` 변환이 throw하면 해당 raw는 버리고 onError로 통지한다. `outbound` 변환이 throw하면 `send()`가 그대로 throw한다 — L3가 request reject로 변환하므로 발신 실패가 조용히 사라지지 않는다 (기준 4).

## 3. createSyncTicker — 서비스 측 tick 도구 (opt-in)

```ts
export interface SyncTickerOptions {
    /** 정상 주기 */
    intervalMs: number;
    /** 실패 시 지수 backoff 배수 (기본 2) */
    factor?: number;
    /** backoff 지연 상한 (기본 60_000ms) */
    maxMs?: number;
}

export interface SyncTickerSupportable {
    start(): void;
    stop(): void;
    readonly running: boolean;
}

export const createSyncTicker = (tick: () => Promise<unknown>, options: SyncTickerOptions): SyncTickerSupportable;
```

- 이전 tick이 끝난 뒤 다음을 예약한다(setTimeout 체인) — 겹침이 없다. tick이 in-flight인 동안의 stop→start 재시작도 체인이 하나만 남는다(epoch 토큰).
- tick이 reject하면 지연을 `min(직전 지연 × factor, maxMs)`로 늘리고, 성공하면 `intervalMs`로 복원한다.

## 파일 구조와 export

```
src/socket/
└── decorators.ts       # createReconnectingNetwork, createTranslatedNetwork (+ decorators.spec.ts)
src/sync/
└── ticker.ts           # createSyncTicker (+ ticker.spec.ts)
```

- `src/socket/index.ts`와 `src/sync/index.ts`에 각각 re-export 1줄 추가. 기존 socket 계약은 무변경(additive — 신규 파일과 export 추가만).
- decorator spec은 L1 단독으로 검증한다(socket은 sync를 모른다). translator+L3 조합 증명은 `src/sync/client.spec.ts`에 있다.

## 검증 시나리오

1. **재연결 e2e**: 내부 network를 죽인 뒤 — backoff 후 새 세대로 교체, `onReconnect` 발화, 같은 인스턴스로 send/onMessage 재개, `generation` 증가.
2. **open 시점 성공 판정**: connecting에 머무는 후보는 정착시키지 않고(`onReconnect` 0회), open 시점에만 세대 전환. open 전에 죽는 후보는 실패로 집계되어 `maxRetries` 소진 시 영구 closed.
3. **끊김 중 발신**: `send()` 동기 throw. L3 조합에서 request reject로 변환되는 것은 client.spec의 send-throw 케이스가 보증.
4. **중단 규칙**: `close()` 후 재연결 없음. `maxRetries` 도달 시 onError 후 영구 closed.
5. **translator**: 예제 suffix codec의 raw 재작성, `inbound` undefined drop, `inbound` throw 시 drop+onError. 조합 증명(번역된 레거시 wire 위에서 L3 `request()` settle)은 client.spec에서.
6. **ticker**: 주기 유지, 실패 backoff(상한 포함), 성공 복원, stop 후 무호출, in-flight 중 stop→start에 체인 단일성.

## 비범위

- 발신 큐잉·오프라인 버퍼링 (기준 4 — 끊김 중 발신은 실패가 정답, tick이 복구 수단)
- 봉투 레벨 keep-alive ping (기준 2 — L3+ 후속)
- 연결 상태 UI 모델링 (서비스 소관, `onReconnect`/`onError`로 충분)
- auth 게이트·rotation 정책 (정책 계층 소관 — rotation 기계는 factory 클로저로 자연 지원)
