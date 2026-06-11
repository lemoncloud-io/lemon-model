# Socket Client Core Migration Spec

문서 순서: [00-requirement.md](./00-requirement.md) → `01-spec.md` → [02-design.md](./02-design.md)

이 문서는 구현 목표, 결정사항, 마이그레이션 단계, 고려사항, 검증 기준을 정의한다. 사용자 요구사항은 `00-requirement.md`, 확정 인터페이스와 다이어그램은 `02-design.md`를 기준으로 한다.

## 구현 목표

`lemon-model`에 generic socket client core를 추가하고, `chatic-sockets-api/src/client-socket-v2`는 그 core를 사용하는 adapter로 전환한다.

새 core는 다음 책임을 가진다.

- raw network 또는 WebSocket transport lifecycle 관리
- outbound message serialization
- inbound message parsing
- `mid` 기반 pending request 관리
- request queue, max inflight, max pending 제한
- message type routing
- shared timer scheduling
- keep-alive
- reconnect backoff
- proactive connection rotation

새 core가 가지면 안 되는 책임:

- chatic packet registry
- chatic packet alias registry
- `device.*` 도메인 gateway
- `message.type` suffix `:ok` / `:error` 규칙의 hard-code
- server-specific sync data shape

## 현재 코드 매핑

| chatic 파일 | 현재 책임 | 이관 방향 |
| --- | --- | --- |
| `socket-transport.ts` | WebSocket 생성, connect timeout, event wrapper | lemon-model client transport로 일반화 |
| `pending-request-store.ts` | `mid` pending request, timeout, `:ok` / `:error` settle | store는 이관, settle은 strategy로 분리 |
| `message-router.ts` | type 기반 routing | generic router로 이관 |
| `shared-timer-scheduler.ts` | shared timer scheduler | 그대로 이관 가능 |
| `keep-alive-loop.ts` | ping loop, pong timeout | small port 기반 controller로 이관 |
| `reconnect-controller.ts` | backoff reconnect | small port 기반 controller로 이관 |
| `connection-rotation-controller.ts` | max lifetime 전 proactive reconnect | small port 기반 controller로 이관 |
| `create-client-socket-v2.ts` | facade, queue, transport 조립 | chatic adapter로 축소 |
| `sync-scheduler.ts` | domain sync orchestration | generic 일부 가능, chatic에 우선 잔류 |
| `gateways/*` | domain gateway | chatic 잔류 |
| `plans/device-sync-plan.ts` | device sync domain policy | chatic 잔류 |

## 결정사항

### 1. 기존 `Peer`는 재사용하지 않는다

`Peer`는 `result` / `error` / `pong` 타입을 중심으로 한 peer simulator다. chatic은 `device.read:ok`, `device.read:error`처럼 suffix 기반 response type을 사용한다.

따라서 이번 migration의 중심은 `Peer`가 아니라 `NetworkSupportable` 위의 새 `SocketClientCore`다.

### 2. 기존 socket API는 additive-only로 보존한다

기존 파일의 public contract를 바꾸지 않는다.

- `src/socket/types.ts`
- `src/socket/transport.ts`
- `src/socket/websocket.ts`
- `src/socket/socket.ts`
- `src/socket/testing.ts`

새 기능은 `src/socket/client` 하위에 추가한다.

### 3. request settle 규칙은 strategy로 주입한다

core는 `mid`와 pending map만 안다. 성공/실패 판정은 adapter가 제공한다.

chatic adapter는 다음 규칙을 제공한다.

- success: `message.type.endsWith(':ok')`
- failure: `message.type.endsWith(':error')`
- id: `message.mid`
- success data: `message.data`
- failure error: `message.error` 기반 `Error`

### 4. WebSocket ownership을 분리한다

기존 `BrowserWebSocketNetwork`는 외부에서 주입된 WebSocket을 감싸는 adapter이며, `close()`는 실제 close보다 detach 의미에 가깝다. 이 동작은 유지한다.

chatic 요구사항인 URL 기반 socket 생성, connect timeout, actual close lifecycle은 새 `WebSocketClientTransport`에서 담당한다.

### 5. runtime controller는 작은 port에만 의존한다

keep-alive, reconnect, rotation은 `ClientSocketV2`에 직접 의존하지 않는다.

구체 port/interface는 `02-design.md`에서 정의한다.

### 6. 새 client 기능은 additive module로 추가한다

새 기능은 기존 socket API와 별도 계층으로 추가한다. 구체 파일 구조와 export 설계는 `02-design.md`에서 정의한다.

### 7. chatic 내부 common modules는 한 릴리스 동안 deprecation bridge를 허용한다

외부 소비자가 chatic의 내부 모듈을 직접 import했을 가능성을 고려해, migration 직후 삭제보다 thin re-export 또는 deprecated wrapper를 우선한다. 완전 제거는 별도 release note와 함께 진행한다.

### 8. `sync-scheduler`는 1차 migration에서 chatic에 남긴다

`sync-scheduler`는 generic orchestration 요소가 있지만 `DomainSyncPlan`과 chatic domain trigger 규칙에 가깝다. 1차 migration에서는 chatic에 남기고, 다른 domain에서 재사용 필요가 확인될 때 별도 일반화한다.

### 9. dependency 방식은 개발/릴리스에서 분리한다

개발 중에는 local path 또는 workspace dependency를 사용하고, 배포 시에는 published `lemon-model` version을 명시한다.

## chatic adapter 구조

`chatic-sockets-api/src/client-socket-v2/create-client-socket-v2.ts`는 다음을 조립한다.

- chatic message parser
- chatic message serializer
- chatic request settlement strategy
- packet alias resolver
- lemon-model `SocketClientCore`
- optional keep-alive/reconnect/rotation controllers
- keep-alive ping message factory

chatic에 남는 책임:

- `SocketPacketRegistry`
- `SocketPacketAliasRegistry`
- typed packet request/response inference
- `createDomainGateway`
- `createDeviceGateway`
- `DeviceSyncPlan`
- package export compatibility

## 마이그레이션 단계

### Phase 1: lemon-model core 추가

- `src/socket/client` 추가
- `SharedTimerScheduler`, `PendingRequestStore`, `MessageRouter` generic 구현
- `SocketClientCore` 구현
- WebSocket client transport 추가
- 기존 socket tests 통과 확인

### Phase 2: runtime controller 추가

- keep-alive controller
- reconnect controller
- rotation controller
- controller는 `SocketRuntimePort`에만 의존
- keep-alive는 packet type을 알지 않고 `buildMessage()`로 outbound message를 받음
- chatic behavior parity를 기준으로 tests 추가

### Phase 3: chatic adapter 도입

- `createClientSocketV2` 내부에서 lemon-model core 사용
- public API는 유지
- 기존 `client-socket-v2` tests 통과 확인

### Phase 4: 중복 제거

- chatic의 공통 구현을 thin re-export 또는 adapter로 축소
- 도메인 파일은 유지
- npm package build 결과 확인

### Phase 5: 문서와 migration guide 정리

- lemon-model socket client README 추가
- chatic migration note 추가
- package dependency와 export 정책 정리

## 고려사항

### TypeScript 버전

`chatic-sockets-api`는 TypeScript 4.7 계열이다. lemon-model에 추가하는 public type은 TS 4.7 소비자가 이해할 수 있어야 한다.

### Runtime neutrality

`lemon-model` socket core는 browser, Node, custom runtime에서 동작해야 한다. DOM `WebSocket` 타입에 직접 의존하지 않고 기존 `WebSocketCompartible` 계약을 확장 사용한다.

### Error compatibility

chatic tests가 error message를 비교한다. migration 중 error message 변경은 의도된 경우에만 허용한다. 우선은 기존 메시지를 adapter에서 보존한다.

### Request queue behavior

`maxInflightRequests`, `maxPendingRequests`, timeout release 순서를 유지해야 한다. 특히 send 실패 시 pending 제거와 queue release 순서가 중요하다.

### Lifecycle behavior

manual disconnect, reconnect stop, keep-alive pong timeout, rotation restart가 서로 재귀 호출하지 않도록 상태 전이를 명확히 유지한다.

## 검증 기준

lemon-model:

- `src/socket/socket.spec.ts`
- `src/socket/transport.spec.ts`
- `src/socket/websocket.spec.ts`
- 새 `src/socket/client/*.spec.ts`

새 `src/socket/client` tests는 다음 동작을 검증한다.

- generic pending request settlement
- duplicate `mid` conflict
- request timeout
- request queue release on success, failure, send error
- message router any/type routing
- shared timer scheduler cancel/cancelAll
- WebSocket client transport connect timeout
- WebSocket client transport actual disconnect
- keep-alive request mode timeout
- reconnect backoff and give-up
- rotation restart

chatic:

- `pending-request-store.spec.ts`
- `message-router.spec.ts`
- `shared-timer-scheduler.spec.ts`
- `create-client-socket-v2.spec.ts`
- `keep-alive-loop.spec.ts`
- `reconnect-controller.spec.ts`
- `connection-rotation-controller.spec.ts`
- `socket-runtime.spec.ts`
- `create-device-runtime.spec.ts`
- `plans/device-sync-plan.spec.ts`
- package `lib:build`

chatic parity tests는 다음 동작 보존을 검증한다.

- `ping` alias to `system.ping`
- `device.*` gateway behavior
- `message.type` suffix `:ok` / `:error` settlement
- error message compatibility
- max inflight behavior
- max pending behavior
- reconnect lifecycle
- keep-alive pong timeout
- rotation behavior
- sync scheduler behavior

## Acceptance Criteria

- 기존 lemon-model socket import가 깨지지 않는다.
- 기존 chatic `createClientSocketV2` 사용자 코드는 변경 없이 동작한다.
- lemon-model 새 core는 chatic type을 import하지 않는다.
- chatic adapter는 `message.type` suffix `:ok` / `:error` protocol을 명시적으로 소유한다.
- WebSocket close ownership이 문서와 구현에서 명확하다.
- migration 후 중복 socket lifecycle 구현이 chatic에서 제거되거나 thin adapter로 축소된다.
