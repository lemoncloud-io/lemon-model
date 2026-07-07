# Sync Playground Design

문서 순서: [01-design](./01-design.md) → [04-network-decorators](./04-network-decorators.md) → [05-version-axis](./05-version-axis.md) → `06-playground.md`

## 개요

sync machine의 의미론(판정·워터마크·안전망)은 현재 Peer 시뮬레이터 spec으로만 검증되어 비가시적이다. 이 문서는 그 의미론을 **눈으로 검증**하는 브라우저 플레이그라운드를 정의한다 — 디버깅 보조, [03-client-guide](./03-client-guide.md)의 살아있는 데모, 채택 설득 자료를 겸한다. (2026-07-06 논의 확정: 시뮬레이터 기반, 실서버 연결은 비범위)

## 포지션 (설계 기준 판정)

- **레이어도 부품도 아닌 도구**다 — `createSyncTicker`와 같은 부류이나, 그보다도 바깥: 라이브러리가 아니라 **저장소 부속물**이다.
- **패키지 밖에 산다**: `demo/` 디렉터리. `package.json`의 `files: ["dist/**/*"]` whitelist가 자동으로 npm 배포에서 제외한다. production 코드·계약은 한 줄도 바뀌지 않는다.
- **계약 무변경으로 관찰한다** (기준 3의 응용): wire 관찰은 demo 안에서 조립하는 L1 tap decorator, 판정 관찰은 어댑터 재실행(아래), 반영 관찰은 `onChange`, 서버 대역은 `socket/testing`의 `Peer` + `sync/testing`의 `createPeerBridge`. 머신에 관찰용 훅을 추가하지 않는다.
- **lemon-model 기능만으로 검증한다**: 화면의 모든 시각 요소는 lemon-model 공개 계약이 만들어내는 관측값(onChange 통지, wire envelope, 어댑터 순수 함수의 출력)에서 유도돼야 한다. demo가 자체 계산하는 값(워터마크 이력 등)은 반드시 lemon-model이 만드는 관측값(다음 pull의 since)과 대조되는 형태로만 화면에 올린다 — 대조 상대가 없는 자체 계산값은 시각화 대상이 아니다.
- **의존성 무추가**: `npm run build`가 만드는 `dist/esm`은 확장자 보정된 ESM이라 브라우저가 직접 로드한다(`fix-esm-build.cjs`). 번들러·devDependency 추가 없음. 정적 서버(`npx serve` 등)로 연다.

## 구성

```
demo/
└── sync-playground/
    ├── index.html      # 단일 페이지 (레이아웃 + <script type="module">)
    └── playground.js   # dist/esm 상대 import로 조립하는 데모 로직
```

브라우저 안에서 전부 돌아간다. **클라이언트는 N개**를 동적으로 추가한다(2026-07-07 확장) — 각 시뮬레이터 클라이언트는 자기 `createPeerBridge()` 위에 `createSocketClient` + `createSyncMachine`을 올리고, 모든 브리지의 서버 `Peer`에 같은 pull 핸들러(공유 `serverModels`)를 붙여 **하나의 논리 서버**를 이룬다. 이벤트/tombstone은 전 브리지 broadcast — 여러 클라이언트의 독립 워터마크와 수렴이 관찰된다. spec의 `attachUserServer` 패턴을 UI 조작으로 옮긴 것이다.

**실소켓 클라이언트(관찰 전용)**: URL 입력으로 `createOwnedWebSocketNetwork({ url })` 기반 클라이언트를 추가할 수 있다 — L1만 교체되고 tap·판정·워터마크 관찰은 동일하게 동작한다. 서버 대역 조작은 닿지 않으며(외부 서버), 서버가 sync wire 계약을 구현했는지(since 필터·tombstone 축값)를 눈으로 검사하는 용도다. 서버 대역 모델은 빈 상태로 시작하고 id·축값을 직접 입력해 추가한다(프리셋은 자기 표본을 스스로 심는다). pull 실패 주입도 spec 관용구 그대로다 — `error` post 후 **throw**로 `Peer.dispatch`의 자동 result reply를 억제해야 spurious result와의 경쟁(unordered 전달에서 비결정적 "성공")을 막는다.

import 진입점은 상대경로 둘이다: `dist/esm/sync/index.js`(client/machine/ticker)와 `dist/esm/sync/testing.js`(PeerBridge). 후자는 package `exports`에 없는 경로라(격리 정책) 패키지 스펙시파이어로는 못 부르고, demo가 저장소 내부라서 상대경로로만 가능하다.

## 화면과 시각화 대상

3열 레이아웃. 왼쪽에서 일으키고, 가운데로 흐르고, 오른쪽에서 수렴한다.

| 열 | 내용 | 관찰 지점 |
| --- | --- | --- |
| **서버 대역** | 서버 모델 테이블 편집(추가/갱신/삭제·버전 값 직접 입력), 이벤트 전송, pull 실패 주입(post+throw), **무응답 주입(post 없이 throw — L3 timeout 관찰)**, 페이지 크기 조절 | `Peer` 서버 쪽 |
| **wire 로그** | envelope 스트림: 방향·**상대 시간**·type·mid·직렬화 크기. `result`/`error` 짝 표시, sync pull envelope은 어댑터-인지 디코딩으로 `since` 하이라이트. 상대 시간은 실패 지속 시 ticker backoff(간격 2배 증가)의 관찰 수단 | L1 tap decorator |
| **클라이언트** | 스토어 테이블(반영분 하이라이트), **워터마크 현재값 + 전진 이력(유발 mid 표기)**, 판정 로그(반영/무시·사유·**유발 mid** — wire 로그와의 상관 키), pull reject 표시 라인, tick 버튼(`machine.tick()` 직접 호출)과 주기 토글(`createSyncTicker`) | `onChange` + 어댑터 재실행 |

wire tap은 **`bridge.network`를 send+onMessage 양방향으로 감싸는 decorator**다 — `onMessage` 구독만으로는 downlink(수신)만 보여 pull 요청이 로그에서 빠진다. 클라이언트 쪽 `Peer`에 리스너를 다는 방식은 금지다(자동 result reply 에코 함정 — [01-design 파일 구조 절](./01-design.md#파일-구조와-export)).

UX 리뷰(2026-07-07 반영)로 확정된 추가 관측 표면과 규칙:

- **상단 `pending` 배지**: L3 `pendingCount` 표시 — 01#3(tick 재진입 스킵)의 유일한 간접 관측을 화면으로 보강.
- **판정 로그의 유발 mid**: 3열 인과(서버에서 일으킴 → wire → 판정/스토어)를 육안 매칭이 아니라 mid 상관 키로 잇는다. 워터마크 이력의 각 전진에도 유발 mid를 단다.
- **pull reject / onError 라인**: error 응답으로 reject된 pull을 "스토어·워터마크 무변화"와 함께 표기. timeout은 무응답 주입(서버가 post 없이 throw — 자동 reply 억제의 spec 관용구 재사용)으로 발생시켜 `client.onError`로 관찰한다(데모는 관찰 가능하도록 `timeoutMs: 5s` 주입 — 정책은 상위 소관이라는 기준 1의 예시). send 실패 표면은 발생 경로가 없어 제외.
- **페이지 단위 통지 가시화**: pull의 페이지별 `onChange` emit을 판정 로그에 페이지 단위 행으로 남긴다 — page size 컨트롤의 존재 이유.
- **축 토글의 파괴성 안내**: "close 후 재등록 · 로컬 상태 리셋"을 토글 옆에 상시 표기. 스토어·판정 로그의 버전 컬럼 라벨은 현재 축 표기를 따른다.
- **표본/화면에 장식 요소 금지**: in-memory 브리지에는 끊김이 없으므로 연결 상태 표시 같은 불변 지표는 두지 않는다.

핵심 시각화 3가지 — 이것이 안 보이면 도구의 존재 이유가 없다:

1. **판정**: 수신 모델별 반영(초록)/무시(회색·사유) 구분. 무시 사유는 계약이 노출하지 않으므로 demo가 **자기 어댑터를 재실행해 추론**한다 — `parseEvent`로 소유 판정 먼저(미소유 이벤트를 stale로 오라벨하지 않기 위해 순서 필수), 소유면 `versionOf(incoming)`과 로컬 버전을 비교해 사유를 붙인다(예: "stale: incoming 3 ≤ local 4"). 스토어 diff만으로는 미소유와 stale이 구분 불가능하다(둘 다 무변화+무통지). 재실행의 안전성은 parseEvent·versionOf의 순수·total 계약이 보장한다. 추론임을 UI에 명시.
2. **워터마크**: pull 후 전진 값과, **이벤트 반영 후에도 전진하지 않음**을 이력으로 보여준다 — 안전망 규칙의 시각화.
3. **since 왕복**: 다음 pull 요청의 `since`가 워터마크와 일치함을 wire 로그에서 확인. `since`는 어댑터 payload 내부에 있으므로 generic 로그로는 안 보인다 — wire 로그가 sync pull envelope만 어댑터-인지 디코딩해 하이라이트한다(위 표).

## 축 토글과 시나리오 프리셋

- **축 토글**: `updatedAt` 어댑터 ↔ `seq` 어댑터(`versionOf: m => m.seq`) 전환. 재등록은 옵션을 무시하므로([05](./05-version-axis.md) 계약 변경 절) close 없이는 전환이 불가하다 — **`handle.close()`**(machine.close() 아님) 후 재등록으로 구현하고, 이때 스토어·워터마크가 리셋되고 `onChange` 재구독이 필요함을 UI 동작에 반영한다(리셋 자체도 "축이 바뀌면 로컬 상태는 무효"라는 의미론의 시각화다).
- **시나리오 프리셋**: 버튼 하나로 검증 시나리오를 재현하는 스크립트. [01-design 시나리오](./01-design.md#검증-시나리오-peer-simulator) 1~3(단방향 e2e, 판정, pull 오류)과 [05 시나리오](./05-version-axis.md#검증-시나리오-peer-simulator) 2~5(seq 축, undefined 판정, 워터마크 축 독립, tombstone). 프리셋은 자동 판정하지 않는다 — 재현만 하고 판단은 화면을 보는 사람이 한다(spec이 이미 자동 검증을 담당).

프리셋의 정직한 한계 3가지 (spec과의 분업):

- 01#2의 pull/이벤트 인터리빙은 bridge 기본 전달이 unordered+jitter라 **확률적 재현**이다 — 특정 순서를 버튼으로 고정할 수 없다.
- 01#3의 tick 재진입 스킵은 in-flight promise join이라 관찰 지점이 없다 — pull 요청 횟수(wire 로그)로 간접 확인만 가능.
- 05#3의 "로컬 버전 undefined → stale 덮음" 절반은 UI로 도달 불가(applyOne이 무버전 모델을 저장하지 않으므로) — spec 전용(private store 시딩)이며, 프리셋은 incoming-undefined 절반만 재현한다.

## 구현 구조

UI 목업(3열 레이아웃·판정 로그·워터마크 이력·since 하이라이트)은 2026-07-07 확정. `playground.js`는 파일 하나로 유지하되 내부 구획을 다음 경계로 나눈다 — 각 구획은 위 관찰 설계와 1:1 대응한다.

| 구획 | 책임 | 의존 |
| --- | --- | --- |
| `tap` | `bridge.network`를 send+onMessage 양방향으로 감싸 wire 로그 콜백 호출. `NetworkSupportable` 계약 그대로 구현(decorator) | dist/esm/socket |
| `serverBand` | spec `attachUserServer` 패턴의 UI 구동판: 모델 테이블 상태, pull 핸들러(페이지네이션·post+throw 실패 주입), 이벤트/tombstone 전송 | dist/esm/sync/testing |
| `judge` | 판정 추론기: 수신 envelope마다 현재 어댑터의 `parseEvent`(소유 판정) → `versionOf` 비교(사유) 재실행. 결과는 판정 로그 렌더러로 | 현재 축 어댑터 |
| `axis` | `updatedAt`/`seq` 어댑터 정의 + 축 토글 절차(`handle.close()` → 재등록 → `onChange` 재구독 → 화면 리셋) | dist/esm/sync |
| `presets` | 시나리오 스크립트(01#1~3, 05#2~5) — serverBand 조작의 시퀀스일 뿐, 전용 경로 없음 | serverBand |
| `render` | 스토어 테이블·워터마크 이력·wire 로그·판정 로그의 DOM 갱신. 프레임워크 없음(vanilla) | — |

- 워터마크 이력은 머신이 노출하지 않으므로 demo가 추적한다: pull `onChange` 시 반영분의 `max(versionOf)`로 자체 계산 — 머신과 같은 규칙의 병행 구현이며, wire 로그의 다음 pull `since`와 일치하는지가 곧 화면상의 검증이다.
- 상태는 모듈 최상위 하나의 `state` 객체(현재 축, 핸들, 로그 배열)로 관리한다. 프레임워크·빌드 도구를 넣지 않는다.

## 비범위 (후속)

- ~~실서버 연결~~ → **관찰 전용 실소켓 클라이언트로 축소 반영**(2026-07-07, 위 구성 절). 인증·재연결 결합, 실서버 대상 조작 UI는 여전히 비범위.
- **judgement trace 훅**: 무시 사유의 정확한 노출은 opt-in 관찰 훅이라는 계약 확장이 필요하다. 플레이그라운드의 diff 추론이 불충분하다고 확인되면 별도 논의로 연다.
- **재연결 데모**(`createReconnectingNetwork` 끊김/복구 시각화): 유용하나 in-memory `Network`에는 "끊김"이 없어 모의 계층이 더 필요하다. 1차 제외.
- CI 연동·스크린샷 회귀 테스트: 도구는 수동 검증용이다. 자동 검증은 spec의 몫.
