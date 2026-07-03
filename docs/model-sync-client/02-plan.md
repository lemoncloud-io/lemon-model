# Model Sync Client Implementation Plan

문서 순서: [00-requirement](./00-requirement.md) → [01-design](./01-design.md) → `02-plan.md`

이 문서는 작업 계획이다. 계약(인터페이스·의미론)의 원천은 01-design이며, 이 문서는 순서·검증 게이트·완료 기준만 정한다.

## 구현 원칙

- 01-design의 인터페이스와 의미론을 계약으로 삼는다. 구현 중 계약을 바꿔야 한다면 코드를 고치지 말고 멈춰서 문서 수정을 먼저 제안한다.
- `src/socket`, `src/genai`, `src/buffer`, `src/types`는 수정하지 않는다. 변경은 `src/sync/` 신설과 루트 `src/index.ts`의 export 1줄 추가로 제한한다(additive).
- 각 단계는 spec 먼저 작성 → 구현 → 게이트 통과 순서로 진행한다.
- 기존 코드 스타일을 따른다: `/** ... */` 한 줄 주석, `createXxx` 팩토리, `XxxSupportable` 계약 이름, `@copyright (C) 2026 LemonCloud Co Ltd.` 헤더. 참고 예시는 `src/socket/transport.ts`, `src/socket/websocket.ts`.

## 검증 명령

| 게이트 | 명령 |
| --- | --- |
| 타입/린트 | `npm run lint` |
| 테스트 | `npm test` (jest) — 부분 실행은 `npx jest src/sync --config=jest.config.json` |
| 빌드 | `npm run build` (cjs+esm) |
| export 정책 | `npm run test:package-exports` |
| 회귀 | 기존 스위트 전체 무손상: `npm test` |

## 작업 순서

### 1단계 — 타입 계약 (`src/sync/types.ts`)

01-design "Public Interfaces" 두 섹션의 선언을 그대로 옮긴다: `SocketClientIdentityProvider`, `SocketClientOptions`, `SocketRequestOptions`, `SocketClientSupportable`, `SyncChangeEvent`, `SyncReplyPage`, `SyncProtocolAdapter`, `ModelSyncOptions`, `ModelSyncSupportable`, `SyncMachineSupportable`. 기존 타입(`SocketMessage`, `NetworkSupportable`, `SocketUnsubscribe`, `SocketErrorHandler`, `RawOwnershipPredicate`, `CoreModel`)은 `../socket`/`../types`에서 import한다.

- 게이트: `npm run lint` 통과. 신규 타입 선언과 문서 계약이 1:1인지 대조.

### 2단계 — 테스트 브리지 (`src/sync/testing.ts`)

`Peer`를 `NetworkSupportable` 하나로 감싸는 브리지를 만든다(01-design "파일 구조와 export" 참고). `send(raw)`는 uplink(`client.network`)에 raw 그대로 발신, 수신은 커스텀 `networkFactory`로 캡처한 downlink `Network`에 직접 구독, `readyState`/`ready`/`onError`/`close`는 클라이언트 Peer에 위임한다. `Peer`는 저장소 내부이므로 상대 경로 `../socket/testing`으로 import한다.

- 주의: 클라이언트 쪽에 `Peer.onMessage()` 리스너를 달지 마라. `Peer.dispatch`(`src/socket/socket.ts:836-843`)는 리스너가 있으면 반환값이 `undefined`여도 자동 `result` reply를 발신하므로, 양쪽 Peer에 리스너가 있으면 빈 result가 무한 왕복한다. 같은 이유로 서버 대역 spec에서 "무응답"을 흉내낼 때는 핸들러를 `return;`으로 끝내지 말고 `throw`로 끝낸다.
- 게이트: 3단계 spec에서 브리지를 통해 요청-응답 왕복이 성립하면 통과로 본다(브리지 단독 spec은 만들지 않는다).

### 3단계 — L3 runtime (`src/sync/client.ts` + `client.spec.ts`)

`createSocketClient` 구현. 검증 시나리오 5·6(01-design "검증 시나리오")을 spec으로 먼저 쓴다. spec 배선은 반드시 2단계 브리지를 쓴다 — 맨 `createNetwork()` 공유 버스에 L3를 직접 올리면 `Network.send()`가 모든 리스너에 배달되어 자기 발신 에코를 듣는다.

spec 체크리스트:

- request가 `result`로 resolve, `error`로 reject되고 mid가 매칭된다.
- timeout(기본 15s, 요청별 재정의) 시 reject되고 pending에서 제거된다.
- timeout 후 늦게 도착한 응답이 onMessage로 새지 않고 무시된다.
- maxPending 초과 request는 즉시 reject된다.
- `network.send()` 동기 throw(`1009: message too big` 포함)가 request reject / post onError로 변환된다.
- `filter` 설정 시 `createFilteredNetwork`로 감싸져 비대상 raw가 무시되고, 미설정 시 envelope parse 실패 raw가 조용히 무시된다.
- `close()`가 pending 전부 reject + listener detach하며 network는 닫지 않는다.

- 게이트: `npx jest src/sync` 통과.

### 4단계 — L4 sync machine (`src/sync/machine.ts` + `machine.spec.ts`)

`createSyncMachine` 구현. 검증 시나리오 1·2·3을 spec으로 먼저 쓴다. UserModel 예제(`interface UserModel extends CoreModel<'user'>`)와 어댑터 구현을 spec 안에 둔다.

spec 체크리스트 (01-design "updatedAt 최신 판정" 표의 행 전부 + 아래):

- register → initialPull(기본 true) → 스토어 반영. initialPull 실패 시 register는 유효하고 다음 pull이 처음부터 당긴다.
- pull 커서 루프: `parseReply().next`가 있는 동안 `buildPull(since, cursor)` 반복, 2페이지 전량 반영.
- 이벤트 디스패치: `result`/`error`/`ping`/`pong` 타입 제외, 전 핸들 `parseEvent` fan-out, `undefined` 핸들 미반영.
- 최신 판정: 신규 반영, 오래된 updatedAt 무시, 같은 값 무시, updatedAt 없는 수신 무시, 로컬 updatedAt 없으면 덮음, deletedAt 제거(로컬에 없으면 무시).
- 워터마크: 반영 시에만 전진, pull 오류·오래된 수신에도 후진하지 않음.
- pull 오류: `pull()` reject, 스토어·워터마크 무변경. tick 재진입 시 진행 중 타입 스킵.
- `onChange`가 cause(`pull`/`event`)와 변경 모델을 통지하고 unsubscribe가 동작한다.
- register 재등록이 기존 핸들을 반환하고 새 options를 무시한다.

- 게이트: `npx jest src/sync` 통과.

### 5단계 — 공존 spec (machine.spec.ts에 추가)

검증 시나리오 4: 한 `Network` 위에 sync runtime(L3+L4) + `createJSONTransport` receiver + progress 문자열 스트림을 함께 올리고 상호 오수신·pending 오염이 없음을 확인한다. 시나리오 구성은 `src/genai/transport.ts`의 `createFilteredNetwork` 사용 패턴을 참고한다. 공유 버스에서는 L3가 자기 발신 에코를 수신하므로, sync `filter`(네임스페이스 prefix)와 `parseEvent`의 undefined 반환으로 에코가 무해하게 버려지는 것까지 이 spec에서 함께 확인한다.

- 게이트: `npx jest src/sync` 통과.

### 6단계 — export 배선과 마감

- `src/sync/index.ts`: types/client/machine re-export. `testing.ts`는 노출하지 않는다(`src/socket/index.ts`의 simulator 격리 주석 패턴을 따른다).
- 루트 `src/index.ts`에 `export * from './sync';` 추가.
- 게이트(전체): `npm run lint` && `npm test` && `npm run build` && `npm run test:package-exports` 모두 통과, 기존 스위트 무손상.

## 완료 기준 (Definition of Done)

1. 01-design 검증 시나리오 1~6이 spec으로 존재하고 통과한다.
2. 기존 테스트·빌드·export 검사가 전부 통과한다(회귀 없음).
3. `src/sync/` 밖의 소스 변경이 루트 `src/index.ts` 1줄뿐이다.
4. 신규 public 인터페이스가 01-design 선언과 일치한다. 불일치가 필요했다면 01-design이 먼저 수정되어 있어야 한다.

## 사항 주의

- `Peer` 링크는 단방향 Network 2개다. `peer.network`(uplink)에 L3를 직접 물리면 자기 에코만 듣는다 — 반드시 2단계 브리지를 거친다.
- `Peer`는 `error` 봉투를 스스로 만들지 않는다. 서버 대역에서 오류를 흉내낼 때는 `post({ type: 'error', data, mid }, { clientId })`로 직접 보낸다.
- in-memory `Network`의 기본 전달은 `unordered: true` + jitter다. 순서 의존 assert를 쓰지 말고 수렴 결과를 assert한다.
- 시뮬레이터 패킷 기본 상한은 64kb(`DEFAULT_MAX_PACKET_BYTES`)다. 패킷 제약 spec은 `configureNetwork({ maxPacketBytes })`로 낮춰서 재현한다.
