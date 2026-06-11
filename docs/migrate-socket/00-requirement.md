# Socket Client Core Migration Requirements

문서 순서: `00-requirement.md` → [01-spec.md](./01-spec.md) → [02-design.md](./02-design.md)

이 문서는 왜 이관이 필요한지, 무엇을 지켜야 하는지, 어디까지를 이번 작업의 범위로 볼지를 정리한다. 구현 방식은 [01-spec.md](./01-spec.md), 확정된 모델링과 인터페이스는 [02-design.md](./02-design.md)를 기준으로 한다.

## 사용자 요구사항

`chatic-sockets-api/src/client-socket-v2`에 들어 있는 공통 WebSocket client 기능을 `lemon-model` 쪽으로 옮겨 재사용 가능한 기반으로 정리한다.

이 작업에서 가장 중요한 전제는 하위호환성이다. 기존 `lemon-model/src/socket` 사용자는 코드 변경 없이 계속 동작해야 하며, chatic client를 사용하는 쪽도 가능한 한 기존 public API를 유지해야 한다.

또한 이번 이관은 단순히 파일을 옮기는 작업이 아니다. 공통 socket client가 맡아야 할 책임과 chatic 도메인이 계속 가져가야 할 책임을 분리하고, 구현 전에 요구사항, 스펙, 디자인을 문서로 고정해 이후 구현의 판단 기준으로 삼는다.

## 배경

`chatic-sockets-api/src/client-socket-v2`는 브라우저 WebSocket 클라이언트, 요청-응답 추적, 메시지 라우팅, keep-alive, reconnect, rotation, sync scheduler, 도메인 gateway를 한 패키지 안에서 제공한다.

`lemon-model/src/socket`은 이미 런타임 중립 socket core를 갖고 있다.

- `NetworkSupportable`: raw string network boundary
- `BrowserWebSocketNetwork`: browser-like WebSocket adapter
- `JSONTransport`: 큰 JSON payload chunk/reassembly
- `Peer`: 테스트/개발용 in-memory peer simulator

현재 구조에서는 chatic 안에 공통 client runtime과 제품 도메인 코드가 함께 섞여 있다. 그 결과 다른 프로젝트에서 같은 client runtime을 재사용하기 어렵고, socket lifecycle이나 request tracking 같은 공통 정책도 chatic 구현에 묶여 있다.

따라서 공통 client runtime은 `lemon-model`이 제공하고, chatic은 packet registry, 도메인 gateway, device sync처럼 제품 의미가 있는 책임만 유지하는 방향으로 정리한다.

## 목표

1. `lemon-model`에 도메인 중립적인 socket client core를 추가한다.
2. chatic은 새 core를 조립하고 chatic protocol을 연결하는 adapter 역할로 얇아진다.
3. transport lifecycle, pending request, message routing, timer, keep-alive, reconnect, rotation처럼 제품과 무관한 client runtime 책임을 공통화한다.
4. chatic의 `message.type` suffix `:ok` / `:error` 규칙은 chatic adapter가 계속 소유한다.
5. 기존 `NetworkSupportable`, `JSONTransport`, `BrowserWebSocketNetwork`, `Peer` 계약은 변경하지 않는다.
6. 기존 chatic client test suite를 migration parity 기준으로 사용한다.

## 비목표

이번 작업은 chatic server protocol을 바꾸기 위한 작업이 아니다. 서버 wire protocol, chatic domain packet, `device.*`, `auth.*`, `SocketPacketRegistry`는 chatic의 책임으로 남긴다.

`Peer`를 chatic client의 주 구현으로 바꾸거나, `BrowserWebSocketNetwork`의 close/detach 의미를 바꾸는 것도 범위에 포함하지 않는다. WebSocket server 구현 이관, JSONTransport의 manifest paging, compression, binary protocol 개선도 이번 마이그레이션과 분리한다.

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
- `src/socket/testing.ts`의 simulator 분리 정책 훼손

반대로 다음 변경은 허용한다.

- additive 확장
- 새 공통 client 기능 추가
- chatic adapter가 새 core를 사용하도록 내부 구현 교체

## 성공 기준

작업이 끝났다고 판단하려면 기존 동작이 유지된다는 증거가 필요하다. 최소한 `lemon-model`의 기존 socket tests와 chatic `client-socket-v2` tests가 모두 통과해야 한다.

`lemon-model`은 chatic 도메인 타입을 import하지 않아야 하며, chatic package public API는 기존 소비자가 재컴파일 가능한 수준으로 유지되어야 한다. request timeout, max inflight, max pending, reconnect, keep-alive, rotation, sync scheduler 동작도 migration 전후로 동일해야 한다.

새 core는 chatic에만 맞춘 구현이 아니라, 다른 WebSocket client에서도 사용할 수 있을 만큼 도메인 중립적이어야 한다.

## 운영 관점 원칙

core는 socket client runtime의 정책과 상태기계를 제공한다. 도메인 의미와 프로토콜별 판단은 adapter가 제공한다.

lifecycle ownership은 명확해야 한다. 특히 WebSocket close와 listener detach는 서로 다른 책임으로 보고 섞지 않는다.

마이그레이션은 새 기능을 먼저 추가하고, 그 다음 내부 구현을 교체하며, 마지막에 더 이상 필요 없는 chatic 내부 구현을 정리하는 순서로 진행한다. 하위호환성 검증 없이 기존 socket core 계약을 수정하지 않는다.
