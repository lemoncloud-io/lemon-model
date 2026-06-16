# 03. 소켓 클라이언트 적용 가이드

대상: lemon-model 소켓 코어 위에서 클라이언트를 사용/구현하는 개발자.
범위: lemon-model 소켓 전송 계층의 일반 계약과, 그 위의 고수준 클라이언트 사용법.

이 문서는 소켓 transport에 한정한다. 도메인 옵션(`device` 디바이스 부트스트랩 등)은 별도 문서를 참고한다.

---

## 개요

소켓 전송의 일반 자산은 lemon-model의 소켓 코어(`NetworkSupportable`)다. 프론트/백 공통으로 이 raw 경계를 소비한다.
클라이언트는 두 방식으로 이 코어를 쓴다.

| 소비 모드 | 진입점 | 제공 기능 | 직접 구현 필요 | 적합 |
|---|---|---|---|---|
| A. 고수준 클라이언트 | 고수준 클라이언트 패키지의 팩토리 | 재연결·keepalive·request·라우팅·sync | 없음 | 일반 앱 |
| B. 저수준 raw | lemon-model `createOwnedWebSocketNetwork` | `onOpen/onMessage/onError/send/close` | 재연결·request 등 전부 | 커스텀 클라이언트 |

대부분의 앱은 모드 A를 쓴다. 이 문서는 일반 코어(모드 B의 기반이자 모드 A의 하부)를 정의한다. 고수준 클라이언트별 구체 사용법은 해당 클라이언트 패키지 문서를 참고한다.

---

## 아키텍처

```
[앱 코드]
   │ 고수준 클라이언트 API (connect / send / request / onType ...)
   ▼
[고수준 클라이언트]                       예: chatic client-socket-v2
   │  재연결 · keep-alive · request/response · 타입 라우팅 · 도메인 sync
   │  NetworkSupportable 어댑터 사용
   ▼
[lemon-model 소켓 코어]                   NetworkSupportable (raw 문자열 경계)
   │  owned 어댑터: createOwnedWebSocketNetwork  (소켓 소유, close = 실제 종료)
   │  browser 어댑터: BrowserWebSocketNetwork    (외부 소유 소켓, close = detach)
   │  기본 socketFactory = globalThis.WebSocket
   ▼
[실제 WebSocket]
```

- 재연결, keep-alive(heartbeat), request/response, 타입 라우팅, 도메인 동기화는 고수준 클라이언트 계층이 제공한다.
- lemon-model 코어는 raw 소켓 1개의 생성·연결·종료와 raw 이벤트 매핑을 담당한다.

---

## 일반 코어 (lemon-model)

### NetworkSupportable 경계

raw 문자열 소켓의 공통 인터페이스다. 고수준 클라이언트와 커스텀 클라이언트 모두 이 멤버만 의존한다.

| 멤버 | 역할 |
|---|---|
| `readyState: 'connecting' \| 'open' \| 'closing' \| 'closed'` | 현재 연결 상태(문자열). |
| `ready?(): Promise<void>` | open까지 대기(Promise 모델). |
| `onOpen?(handler): unsubscribe` | open 콜백(이벤트 모델). |
| `send(data: string): void` | 전송. OPEN이 아니면 throw. |
| `onMessage(handler): unsubscribe` | 메시지 수신. |
| `onError(handler): unsubscribe` | 에러/close 수신. `context.scope`로 구분(아래 참고). |
| `configure?(options): void` | 런타임 옵션 적용. |
| `close(code?, reason?): void` | 종료. owned는 실제 close, browser는 detach. |

### 두 어댑터

| 어댑터 | 진입점 | 소유 모델 | `close()` 의미 |
|---|---|---|---|
| owned | `createOwnedWebSocketNetwork(options)` | 어댑터가 소켓을 생성·소유 | 실제 소켓 종료 |
| browser | `BrowserWebSocketNetwork` (외부 소유 소켓 래핑) | 호출자가 소켓 소유 | detach(리스너만 해제, 소켓은 유지) |

- 브라우저에서 owned 어댑터는 `socketFactory`를 생략하면 전역 `WebSocket`을 사용한다.
- owned의 초기 open 타임아웃 기본값은 15초다(`connectTimeoutMs`).

### socketFactory가 반환하는 raw 소켓 계약 (`WebSocketClosable`)

owned 어댑터에 `socketFactory`를 넘기면 아래 계약을 만족하는 객체를 반환해야 한다. 표준 브라우저 `WebSocket`은 그대로 만족한다. (고수준 클라이언트는 이 계약을 자신의 타입명으로 다시 노출한다 — 예: chatic `SocketLike`.)

| 멤버 | 요구사항 | 위반 시 |
|---|---|---|
| `readyState: number` | **필수.** 어댑터가 이 값으로 OPEN 여부를 판단해 send를 막는다. | 없으면 send가 항상 막혀 전송 불가. |
| `addEventListener(type, listener, { once })` | `{ once }` 옵션을 존중한다(open/error/close 일회성 리스너에 사용). | 무시하면 같은 이벤트 콜백이 중복 실행된다. |
| `removeEventListener(type, listener)` | 등록한 리스너를 제거할 수 있어야 한다. | 정리 누락 → 리스너 누수. |
| `send(data)` / `close(code?, reason?)` | 표준 WebSocket과 동일 시그니처. | — |

> 어댑터는 같은 이벤트에 리스너를 둘 이상 등록한다. `addEventListener`는 타입당 리스너를 여러 개 보관해야 하며, 단일 슬롯으로 덮어쓰면 안 된다.

### 동작 원칙

| 항목 | 동작 |
|---|---|
| connect timeout 소유권 | 고수준 클라이언트가 재연결/백오프 정책의 일부로 connect 타임아웃을 소유하면, 코어 어댑터에는 `connectTimeoutMs: 0`을 넘겨 이중 타임아웃을 막는다. |
| 에러/close 구분 | `onError(handler)`는 `(event, context)`를 받는다. `context.scope`(`WEBSOCKET_NETWORK_SCOPE`: owned / ownedClose / browser / browserClose)로 정상 close와 에러를 구분한다. |
| 상태 정규화 | 고수준 클라이언트는 위 raw 신호를 자신의 상태 전이/에러 이벤트로 정규화해 앱에 전달한다. 앱은 raw scope 문자열을 직접 비교하지 않는다. |

### raw 직접 사용 (모드 B)

재연결·request 없이 raw 소켓만 직접 다뤄 커스텀 클라이언트를 만들 때 사용한다.

```ts
import { createOwnedWebSocketNetwork, WEBSOCKET_NETWORK_SCOPE } from 'lemon-model';

const net = createOwnedWebSocketNetwork({ url: WS_URL }); // 브라우저면 socketFactory 생략
net.onOpen?.(() => net.send('hello'));
net.onMessage(raw => handle(raw));
net.onError((event, ctx) => {
    if (ctx.scope === WEBSOCKET_NETWORK_SCOPE.ownedClose) {
        /* 정상 close */
    }
});
```

- 재연결·keep-alive·request/response·타입 라우팅은 제공되지 않는다. 필요한 기능은 직접 구현한다.
- 모드 A로 요구사항을 충족할 수 있는지 먼저 검토한다.

---

## 고수준 클라이언트 사용법

고수준 클라이언트(모드 A)의 구체 사용법 — 팩토리 호출, `socketFactory` 주입, 옵션 — 은 해당 클라이언트 패키지 문서에서 다룬다. 클라이언트마다 import 경로·기본값이 다르므로, 이 문서는 일반 코어 계약만 정의한다.

- 현재 표준 클라이언트: chatic `client-socket-v2`. 사용법은 `chatic-sockets-api` 리포 `docs/frontend-client-socket/`(Client Transport)를 참고한다.

---

관련 문서: `00-requirement.md`, `01-spec.md`, `02-design.md`.
