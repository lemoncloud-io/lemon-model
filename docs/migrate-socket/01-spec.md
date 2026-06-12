# Socket Network Boundary Migration Spec

문서 순서: [00-requirement.md](./00-requirement.md) → `01-spec.md` → [02-design.md](./02-design.md)

이 문서는 수정된 구현 목표, 결정사항, 마이그레이션 단계, 검증 기준을 정의한다. 사용자 요구사항은 [00-requirement.md](./00-requirement.md), 확정 인터페이스와 다이어그램은 [02-design.md](./02-design.md)를 기준으로 한다.

## 구현 목표

`lemon-model`에는 generic socket client runtime을 추가하지 않는다.

대신 chatic client 안에서 네트워크 adapter가 맡던 WebSocket 생성, connect timeout, actual close, raw event mapping 책임만 `lemon-model`의 `NetworkSupportable` 구현으로 옮긴다.

chatic migration에서 `lemon-model`에 신규로 의존하는 계약은 기존 `NetworkSupportable`로 제한한다.

```ts
export interface NetworkSupportable {
    readonly readyState: SocketReadyState;
    ready?(): Promise<void>;
    send(data: string): void;
    onMessage(handler: NetworkMessageHandler): SocketUnsubscribe;
    configure?(options: SocketNetworkOptions): void;
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    close(): void;
}
```

다음 기존 exports는 하위호환성 기준으로 유지하지만, chatic migration이 새로 의존하는 공통 client runtime으로 보지 않는다.

- `NetworkMessageHandler`
- `SocketErrorHandler`
- `BrowserWebSocketNetwork`
- `WebSocketCompartible`
- `JSONTransport`

`chatic-sockets-api/src/client-socket-v2`는 자체 runtime 정책을 유지한다.

- connect/disconnect 호출 흐름
- pending request
- request queue
- max inflight / max pending
- message routing
- keep-alive
- reconnect
- connection rotation
- packet alias
- `:ok` / `:error` settlement
- sync scheduler
- domain gateway

추가 구현의 중심은 다음 두 가지다.

1. chatic WebSocket network adapter를 `lemon-model`의 owned `NetworkSupportable` 구현으로 이관
2. chatic/proxy 수신 경로의 ownership filter 추가

## 확정 이관 범위

결론: chatic에서 `lemon-model`로 끌고 올 Network 관련 모듈은 `../chatic-sockets-api/src/client-socket-v2/socket-transport.ts`의 WebSocket network adapter 책임이다.

`lemon-model`의 구현 대상은 `src/socket/websocket.ts`에 추가하는 `OwnedWebSocketNetwork`와 `createOwnedWebSocketNetwork`다.

반드시 끌고 온다:

- WebSocket 생성
- `url` / `protocols` 전달
- custom `socketFactory` 지원
- connect timeout
- open 상태 대기
- raw string message event mapping
- socket error/close event mapping
- `readyState` mapping
- raw string `send()`와 OPEN 상태 guard
- owned WebSocket actual close
- 위 책임을 표현하는 option/type

반드시 끌고 오지 않는다:

- pending request store
- request queue
- `mid` 기반 request settlement
- `:ok` / `:error` 판정
- chatic message parse
- message router
- keep-alive loop
- reconnect controller
- connection rotation controller
- sync scheduler
- domain gateway
- chatic/proxy ownership rule 자체

chatic 쪽 `socket-transport.ts`는 chatic 내부 event shape와 `OwnedWebSocketNetwork`를 연결하는 thin wrapper로 남긴다. 이 파일은 WebSocket 생성, connect timeout, actual close를 직접 소유하면 안 된다.

## 현재 코드 매핑

| chatic 파일 | 현재 책임 | 수정 방향 |
| --- | --- | --- |
| `socket-transport.ts` | WebSocket 생성, connect timeout, event wrapper, actual close | `src/socket/websocket.ts`의 `OwnedWebSocketNetwork` / `createOwnedWebSocketNetwork`로 이관. chatic에는 thin wrapper로 남김 |
| `pending-request-store.ts` | `mid` pending request, timeout, `:ok` / `:error` settle | chatic에 유지 |
| `message-router.ts` | type 기반 routing | chatic에 유지 |
| `shared-timer-scheduler.ts` | shared timer scheduler | chatic에 유지 |
| `keep-alive-loop.ts` | ping loop, pong timeout | chatic에 유지 |
| `reconnect-controller.ts` | backoff reconnect | chatic에 유지 |
| `connection-rotation-controller.ts` | max lifetime 전 proactive reconnect | chatic에 유지 |
| `create-client-socket-v2.ts` | facade, queue, transport 조립, inbound dispatch | ownership filter 적용 지점 |
| `sync-scheduler.ts` | domain sync orchestration | chatic에 유지 |
| `gateways/*` | domain gateway | chatic에 유지 |
| `plans/device-sync-plan.ts` | device sync domain policy | chatic에 유지 |

## 결정사항

### 1. `SocketClientCore`는 만들지 않는다

chatic runtime 전체를 `lemon-model`로 옮기지 않는다. chatic은 `NetworkSupportable`만 공유해도 동작할 수 있어야 한다.

따라서 `src/socket/client` 같은 새 client runtime 계층은 이번 범위에서 제외한다.

### 2. chatic socket transport 책임은 `lemon-model` adapter로 옮긴다

`socket-transport.ts`에서 네트워크에 해당하는 책임은 `lemon-model/src/socket/websocket.ts`에 추가한다.

이번 범위에서는 별도 `src/socket/client` 계층이나 `src/socket/websocket-owned-network.ts` 파일을 만들지 않는다.

- WebSocket 생성
- `protocols` 전달
- custom `socketFactory` 지원
- connect timeout
- open 전송 대기
- raw string message emit
- error emit
- actual socket close
- OPEN 상태 send guard

이 adapter는 `NetworkSupportable`을 구현해야 한다. chatic message format, `mid`, `:ok` / `:error`, pending settle, router는 알면 안 된다.

확정 export는 다음과 같다.

```ts
export interface OwnedWebSocketNetworkOptions {
    url: string;
    protocols?: string | string[];
    socketFactory?: (context: OwnedWebSocketNetworkFactoryContext) => WebSocketClosable;
    connectTimeoutMs?: number;
}

export interface OwnedWebSocketNetworkFactoryContext {
    url: string;
    protocols?: string | string[];
}

export interface WebSocketClosable extends WebSocketCompartible {
    close(code?: number, reason?: string): void;
}

export class OwnedWebSocketNetwork implements NetworkSupportable {
    constructor(options: OwnedWebSocketNetworkOptions);
}

export const createOwnedWebSocketNetwork = (options: OwnedWebSocketNetworkOptions): OwnedWebSocketNetwork;
```

### 3. 기존 socket API는 그대로 보존한다

기존 파일의 public contract를 바꾸지 않는다.

- `src/socket/types.ts`
- `src/socket/transport.ts`
- `src/socket/websocket.ts`
- `src/socket/socket.ts`
- `src/socket/testing.ts`

단, `NetworkSupportable` 구현체를 추가하는 additive export는 허용한다. 기존 export 제거, 이름 변경, method signature 변경은 금지한다.

### 4. message ownership은 chatic/proxy가 판단한다

수신 메시지가 해당 runtime에서 처리할 메시지인지 판단하는 규칙은 서비스별로 다르다. `lemon-model`은 `mid`, payload, meta, type, connection id 같은 규칙을 알면 안 된다.

따라서 filter는 chatic/proxy option으로 주입한다.

### 5. filter는 pending settle 전에 적용한다

필터가 false를 반환한 메시지는 다음 단계로 전달하지 않는다.

- pending request settlement
- `onMessage`
- `onType`
- sync scheduler trigger
- domain gateway listener

이 순서는 잘못된 runtime이 남의 response를 consume하지 않게 하기 위한 필수 조건이다.

### 6. raw filter와 parsed message filter를 분리한다

parse 전에 버릴 수 있는 메시지가 있다. 예를 들어 proxy가 prefix, envelope, channel marker만 보고 처리 대상이 아니라고 판단할 수 있다.

따라서 두 단계 필터를 허용한다.

- `shouldHandleRaw({ raw })` false: parse하지 않고 무시
- `shouldHandleMessage({ message, raw })` false: parse 이후 dispatch 전에 무시

두 option은 모두 optional이며, 미설정 시 기존처럼 처리한다.

### 7. `BrowserWebSocketNetwork.close()` 의미는 바꾸지 않는다

기존 `BrowserWebSocketNetwork`는 외부에서 소유한 WebSocket을 감싸는 adapter이며 `close()`는 detach 의미다.

actual close가 필요한 chatic network 경로는 새 owned WebSocket network adapter의 `close()`가 처리한다. chatic runtime은 disconnect, reconnect, rotation 같은 정책 결정 후 `NetworkSupportable.close()`를 호출한다.

### 8. raw ownership filter는 `NetworkSupportable` decorator로 제공한다

raw 단계 ownership 판정(`shouldHandleRaw`)은 chatic `createClientSocketV2` 전용 옵션으로만 두지 않는다. proxy는 `createClientSocketV2`를 사용하지 않으므로, chatic 전용 옵션만 두면 proxy가 같은 판정을 임기응변으로 재구현하게 된다.

따라서 raw filter를 `NetworkSupportable`을 감싸는 decorator로 일반화하여 `lemon-model`에 additive로 추가한다. 이 decorator는 source network의 `onMessage`에서 predicate가 false인 raw 문자열을 통과시키지 않는다.

이 방향은 신규 추상화가 아니라 기존 `src/genai/transport.ts`의 private `TransportPacketNetwork`(source network의 `onMessage`를 `isTransportPacketString`로 필터)와 동일한 패턴의 일반화다. proxy는 이미 이 패턴으로 자기 패킷만 소비하고 있다.

decorator predicate는 raw 문자열만 본다. chatic message shape, `mid`, `:ok` / `:error`는 알면 안 된다. parse 이후 판정(`shouldHandleMessage`)은 결정 #6대로 chatic/proxy runtime에 남긴다.

확정 export는 다음과 같다. 구현 위치는 `src/socket/websocket.ts`로 고정하고 `src/socket/client` 신규 계층을 만들지 않는다.

```ts
export type RawOwnershipPredicate = (raw: string) => boolean;

export const createFilteredNetwork = (
    source: NetworkSupportable,
    shouldHandleRaw: RawOwnershipPredicate,
): NetworkSupportable;
```

멤버 위임 규칙은 기존 `TransportPacketNetwork`과 동일하게 고정한다.

- `onMessage`: predicate가 false인 raw는 source 구독자에게 전달하지 않고, true인 raw만 그대로 전달한다. unsubscribe는 source 구독을 해제한다.
- `send` / `close` / `onError`: source로 그대로 위임한다.
- `readyState`: source 값을 그대로 반환한다 (getter 위임).
- optional 멤버 `ready` / `configure`는 decorator에서 항상 정의하고 source로 위임한다. source에 해당 멤버가 없으면 `ready()`는 `Promise.resolve()`, `configure()`는 no-op이다.

predicate는 `onMessage` 경로에서만 적용한다. `send`(outbound)에는 적용하지 않는다.

chatic은 `createClientSocketV2`의 `shouldHandleRaw` 옵션을 계속 노출하되, 내부적으로 이 옵션을 동일 decorator로 적용할 수 있다. proxy는 동일 decorator를 직접 사용한다. 두 경로 모두 `lemon-model`에서 신규로 공유하는 계약은 `NetworkSupportable` 하나로 유지된다.

## lemon-model adapter spec

신규 adapter spec은 `expect2` 기반으로 작성한다.

```ts
import { expect2 } from '../cores/index.spec';
```

테스트 위치는 기존 socket spec 배치에 맞춘다.

- `src/socket/websocket.spec.ts`

테스트해야 할 동작:

- `ready()`는 WebSocket open까지 resolve하지 않는다.
- connect timeout이 발생하면 socket을 actual close한다.
- `send()`는 OPEN 상태에서만 raw string을 전송한다.
- `onMessage()`는 raw string message만 전달한다.
- `onError()`는 socket error/close error를 전달한다.
- `close()`는 actual socket close를 호출한다.
- `BrowserWebSocketNetwork.close()`의 detach 의미는 그대로 유지된다.
- `createFilteredNetwork`는 predicate가 false인 raw message를 source의 `onMessage` 구독자에게 전달하지 않는다.
- `createFilteredNetwork`는 predicate가 true인 raw message는 변경 없이 전달하고, unsubscribe 시 source 구독을 해제한다.
- `createFilteredNetwork`는 `send`/`close`/`onError`/`readyState`를 source로 그대로 위임한다.
- source에 `ready`/`configure`가 있으면 위임하고, 없으면 `ready()`는 즉시 resolve, `configure()`는 no-op이다.
- predicate는 outbound `send`에는 적용하지 않는다.

## chatic option 설계

`ClientSocketOptions`에 다음 optional fields를 추가한다.

```ts
export interface ClientSocketInboundFilterContext {
    raw: string;
}

export interface ClientSocketMessageFilterContext<T = any> {
    raw: string;
    message: SocketMessage<T>;
}

export interface ClientSocketOptions {
    shouldHandleRaw?: (context: ClientSocketInboundFilterContext) => boolean;
    shouldHandleMessage?: (context: ClientSocketMessageFilterContext) => boolean;
}
```

필터는 boolean만 반환한다. async filter는 1차 범위에서 제외한다. inbound dispatch가 동기 순서와 pending settlement 순서에 민감하기 때문이다.

## inbound 처리 순서

`create-client-socket-v2.ts`의 raw message handler는 다음 순서를 따른다.

1. raw 수신
2. `shouldHandleRaw?.({ raw }) === false`면 return
3. parse
4. `shouldHandleMessage?.({ raw, message }) === false`면 return
5. pending settle
6. `onMessage` emit
7. unsettled message만 router/domain sync로 전달

parse 실패는 기존 error 처리와 동일하게 유지한다. 단, raw filter가 false를 반환한 경우에는 parse를 시도하지 않았으므로 parse error도 발생하지 않는다.

## 마이그레이션 단계

### Phase 1: 문서 방향 고정

- `00-requirement.md`를 NetworkSupportable-only 계약 공유와 WebSocket network adapter 이관 방향으로 수정
- `01-spec.md`에서 `SocketClientCore` 이관 계획 제거
- `02-design.md`에서 lemon-model owned adapter, chatic 자체 runtime, ownership filter flow 정의

### Phase 2: lemon-model owned WebSocket network tests 추가

`lemon-model`에서 `expect2` 기반 tests를 먼저 추가한다.

- WebSocket 생성과 `ready()` open 대기
- connect timeout 시 actual close
- raw message 전달
- error 전달
- OPEN 상태 send guard
- `close()` actual close
- 기존 `BrowserWebSocketNetwork.close()` detach behavior 유지
- `createFilteredNetwork` raw predicate 통과/차단과 멤버 위임 (`ready`/`configure` 포함)

### Phase 3: lemon-model owned WebSocket network 구현

`src/socket/websocket.ts`에 `OwnedWebSocketNetwork`, `createOwnedWebSocketNetwork`, `createFilteredNetwork`를 추가한다.

구현은 raw transport adapter에 한정한다.

- JSON parse 없음
- chatic `mid` / `type` / `meta` 규칙 없음
- pending settle 없음
- reconnect/rotation policy 없음

### Phase 4: chatic filter tests 추가

`../chatic-sockets-api`에서 tests를 먼저 추가한다.

- raw filter false면 parse error가 발생하지 않음
- message filter false면 pending settle 안 됨
- message filter false면 `onMessage`/`onType` 호출 안 됨
- filter true면 기존 처리 유지
- filter 미설정 시 기존 처리 유지

### Phase 5: chatic transport 적용과 filter 구현

`socket-transport.ts`는 `lemon-model` owned WebSocket network adapter를 사용하도록 줄이고, chatic 내부 event shape에 맞추는 thin wrapper만 남긴다.

`create-client-socket-v2.ts` inbound handler에 filter를 추가한다.

`types.ts`에 option type을 추가한다.

필터는 chatic message parser, pending store, router, sync scheduler보다 앞에 위치해야 한다.

### Phase 6: 검증

`lemon-model`:

```bash
npm test -- --runTestsByPath src/socket/socket.spec.ts src/socket/transport.spec.ts src/socket/websocket.spec.ts
npm run build
```

`chatic-sockets-api`:

```bash
npm test -- --runTestsByPath \
  src/client-socket-v2/create-client-socket-v2.spec.ts \
  src/client-socket-v2/socket-runtime.spec.ts \
  src/client-socket-v2/sync-scheduler.spec.ts \
  src/client-socket-v2/plans/device-sync-plan.spec.ts
npm run build
```

## 고려사항

### TypeScript 버전

`chatic-sockets-api`는 TypeScript 4.7 계열이다. 새 option type은 TS 4.7에서 동작해야 한다.

### Filter default

filter 미설정은 기존 동작과 동일해야 한다. 기본값은 “모든 메시지 처리”다.

### Error compatibility

필터가 메시지를 거부한 경우에는 error event를 발생시키지 않는다. 처리 대상이 아닌 메시지를 조용히 무시하는 것이 목적이다.

반대로 filter가 true이거나 미설정인 상태에서 parse 또는 handler가 실패하면 기존 error behavior를 유지한다.

### Request timeout

message filter가 false를 반환해 response를 무시하면 해당 pending request는 timeout될 수 있다. 이는 ownership 규칙상 해당 runtime이 그 response를 처리하지 않겠다는 의미이므로 정상 동작이다.

### Rule ownership

id prefix, payload channel, `meta.owner`, connection id 같은 실제 규칙은 이 문서에서 고정하지 않는다. 각 서비스가 predicate로 주입한다.

## 검증 기준

lemon-model:

- 기존 socket tests 통과
- owned WebSocket network adapter 신규 tests 통과
- build 통과
- 기존 socket public API 변경 없음
- `src/socket/client` 신규 계층 없음
- chatic message/pending/router 개념 없음

chatic:

- 기존 client runtime tests 통과
- `socket-transport.ts`가 `createOwnedWebSocketNetwork`를 사용하고 thin wrapper로 축소됨
- ownership filter tests 추가 및 통과
- filter 미설정 시 기존 동작 유지
- filter false 시 pending/router/onMessage/domain trigger가 실행되지 않음

## Acceptance Criteria

- 기존 lemon-model socket import가 깨지지 않는다.
- 기존 chatic `createClientSocketV2` 사용자 코드는 필터 미설정 시 변경 없이 동작한다.
- chatic은 `NetworkSupportable` 외의 lemon-model client runtime에 의존하지 않는다.
- chatic WebSocket network adapter 책임은 `lemon-model`의 owned `NetworkSupportable` 구현으로 이동한다.
- ownership filter는 pending settle 전에 실행된다.
- chatic/proxy가 id 또는 payload 규칙을 predicate로 주입할 수 있다.
- raw ownership filter는 `NetworkSupportable` decorator(`createFilteredNetwork`)로 chatic과 proxy가 동일하게 사용할 수 있다.
