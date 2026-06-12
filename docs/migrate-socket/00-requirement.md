# Socket Network Boundary Migration Requirements

문서 순서: `00-requirement.md` → [01-spec.md](./01-spec.md) → [02-design.md](./02-design.md)

이 문서는 chatic socket client 마이그레이션의 수정된 방향을 정의한다. 구현 방식은 [01-spec.md](./01-spec.md), 확정 모델링과 인터페이스는 [02-design.md](./02-design.md)를 기준으로 한다.

## 사용자 요구사항

`chatic-sockets-api/src/client-socket-v2`는 자체 client runtime을 유지한다.

`chatic-sockets-api`가 `lemon-model`에 기대는 신규 계약은 raw string network boundary인 `NetworkSupportable`로 제한한다. 다만 chatic client 안의 WebSocket 생성, connect timeout, actual close, raw event mapping 같은 네트워크 adapter 책임은 `NetworkSupportable` 구현체로 `lemon-model`에 옮긴다.

chatic은 pending request, message routing, keep-alive, reconnect, rotation, packet alias, `:ok` / `:error` settlement를 자체 구현으로 계속 소유할 수 있어야 한다.

추가로 chatic 또는 proxy는 수신 메시지를 처리하기 전에 “내가 처리할 메시지인지” 판단할 수 있어야 한다. 이 판단은 id, payload, meta, type, connection context 같은 프로젝트별 규칙에 따라 달라질 수 있으므로 `lemon-model`에 하드코딩하지 않는다.

이 판단은 chatic뿐 아니라 proxy도 동일하게 쓸 수 있어야 한다. proxy는 chatic의 `createClientSocketV2`를 사용하지 않으므로, ownership 판정을 chatic 전용 옵션으로만 두면 proxy가 같은 판정을 따로 다시 구현하게 된다. 따라서 raw 단계 판정은 양쪽이 공유하는 형태, 즉 `NetworkSupportable` 경계에서 함께 쓸 수 있는 공통 수단으로 제공한다.

## 배경

`chatic-sockets-api/src/client-socket-v2`는 브라우저 WebSocket 클라이언트, 요청-응답 추적, 메시지 라우팅, keep-alive, reconnect, rotation, sync scheduler, 도메인 gateway를 한 패키지 안에서 제공한다.

`lemon-model/src/socket`은 이미 런타임 중립 socket boundary를 갖고 있다.

- `NetworkSupportable`: raw string network boundary
- `BrowserWebSocketNetwork`: browser-like WebSocket adapter
- `JSONTransport`: 큰 JSON payload chunk/reassembly
- `Peer`: 테스트/개발용 in-memory peer simulator

초기 설계는 chatic의 공통 client runtime을 `lemon-model`로 옮기는 방향이었다. 하지만 리뷰 기준으로는 chatic 관련 runtime은 chatic이 자체적으로 유지할 수 있어야 하며, `lemon-model`은 network boundary 공유에 집중해야 한다.

또한 같은 raw stream을 chatic과 proxy가 함께 관찰할 수 있으므로, "내 메시지인지" 판단하는 수단도 특정 runtime에 묶이지 않고 boundary 차원에서 공유되어야 한다. proxy 쪽(`src/genai/transport.ts`)에는 이미 자기 패킷만 골라 받는 유사 구현이 있으므로, 이를 일반화하는 방향으로 정리한다.

## 목표

1. `lemon-model`의 기존 socket 계약을 변경하지 않는다.
2. chatic이 `lemon-model`에서 신규로 공유하는 계약은 `NetworkSupportable`로 제한한다.
3. chatic WebSocket network adapter 책임을 `lemon-model`의 `NetworkSupportable` 구현으로 옮긴다.
4. chatic의 client runtime 정책은 `chatic-sockets-api`에 남긴다.
5. chatic/proxy 수신 처리 앞단에 ownership filter를 둔다.
6. ownership filter는 raw message 또는 parsed message 기준으로 처리 여부를 결정할 수 있다.
7. raw 단계 ownership filter는 chatic과 proxy가 동일하게 쓸 수 있도록 `NetworkSupportable` 경계의 공통 수단으로 제공한다.
8. 필터가 거부한 메시지는 pending settle, `onMessage`, `onType`, domain sync로 전달하지 않는다.
9. 기존 chatic public API는 가능한 한 유지한다.

## 비목표

이번 작업은 chatic runtime 전체를 `lemon-model`로 이관하지 않는다. 이관 대상은 chatic client의 WebSocket network adapter 책임으로 제한한다.

다음 항목은 1차 범위가 아니다.

- `SocketClientCore` 신설
- `PendingRequestStore` 이관
- `MessageRouter` 이관
- shared timer scheduler 이관
- keep-alive/reconnect/rotation controller 이관
- chatic internal common module 삭제
- chatic server wire protocol 변경
- `BrowserWebSocketNetwork.close()`의 detach 의미 변경
- `Peer`를 chatic client 주 구현으로 변경

## 하위호환성 요구사항

기존 `lemon-model` 사용자는 import 경로나 사용 방식을 바꾸지 않아도 계속 동작해야 한다.

```ts
import { BrowserWebSocketNetwork, createJSONTransport } from 'lemon-model';
```

테스트/개발용 simulator 경로도 그대로 유지한다.

```ts
import { createPeer, createNetwork } from 'lemon-model/dist/socket/testing';
```

다음 변경은 하위호환성을 깨는 것으로 본다.

- 기존 export 제거
- 기존 public type 이름 변경
- 기존 method signature 변경
- 기존 error message를 의도 없이 변경
- `BrowserWebSocketNetwork.close()`를 actual WebSocket close로 변경
- `src/socket/testing.ts`의 simulator 분리 정책 훼손

chatic 쪽 하위호환성 기준은 다음과 같다.

- 기존 `createClientSocketV2` public method signature 유지
- 필터 미설정 시 기존 메시지 처리 동작 유지
- 기존 request timeout, max inflight, max pending, reconnect, keep-alive, rotation 동작 유지
- chatic의 WebSocket network adapter 교체는 public API 변경 없이 내부 구현으로 처리

## 성공 기준

`lemon-model`은 기존 socket tests와 build가 통과해야 하며, owned WebSocket network adapter에 대한 신규 tests가 추가되어야 한다.

`chatic-sockets-api`는 기존 `client-socket-v2` tests와 build가 통과해야 하며, `lemon-model` network adapter 적용과 ownership filter에 대한 신규 tests가 추가되어야 한다.

network adapter 성공 기준:

- chatic이 직접 하던 WebSocket 생성, connect timeout, raw message/error event mapping을 `lemon-model` adapter가 제공한다.
- actual socket close가 필요한 경로는 새 owned adapter의 `close()`가 처리한다.
- 기존 `BrowserWebSocketNetwork.close()`는 listener detach 의미를 유지한다.
- adapter는 raw string send/receive만 담당하고 chatic message parse, pending settle, routing을 처리하지 않는다.

ownership filter 성공 기준:

- raw filter가 false를 반환하면 parse를 시도하지 않는다.
- message filter가 false를 반환하면 pending settle을 하지 않는다.
- message filter가 false를 반환하면 `onMessage`와 `onType` listener를 호출하지 않는다.
- filter 미설정 시 기존 동작과 동일하다.
- raw 단계 filter는 chatic과 proxy가 같은 공통 수단으로 사용할 수 있고, proxy는 chatic runtime에 의존하지 않는다.
- 필터 규칙은 chatic/proxy가 주입하며 `lemon-model`에 chatic-specific rule을 추가하지 않는다.

## 운영 관점 원칙

`lemon-model`은 raw transport boundary와 그 boundary를 구현하는 WebSocket network adapter, 그리고 그 boundary에서 처리 대상을 거르는 공통 raw filter 수단을 제공한다. request-response 정책과 domain message ownership은 `chatic-sockets-api` 또는 proxy가 판단한다.

lifecycle ownership은 명확해야 한다. 특히 WebSocket actual close와 listener detach는 서로 다른 책임으로 보고 섞지 않는다.

마이그레이션은 먼저 문서 방향을 고정하고, 그 다음 `lemon-model`에 owned WebSocket network adapter tests와 구현을 추가한 뒤, chatic runtime 내부에서 transport 사용처와 filter를 최소 변경으로 적용한다. `lemon-model` 변경은 additive로 제한한다.
