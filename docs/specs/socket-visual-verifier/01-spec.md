# Spec: socket-visual-verifier

**Status:** Confirmed
**Date:** 2026-07-10
**Slug:** socket-visual-verifier
**Requirement:** [00-requirement.md](./00-requirement.md)
**Design:** [02-design.md](./02-design.md)

## 범위
이 문서는 **계약**(보장·scope)을 고정한다. 모델링·흐름은 [02-design.md](./02-design.md) 참조.

## 핵심 결정

| 결정 | 계약 | 이유 |
|---|---|---|
| 두 검증 경로 분리 | in-memory 경로가 send→result·ping→pong·reconnect를, 실-WebSocket 경로가 청크 왕복·connectionId 핸드셰이크·수명주기·결함 탐지를 검증한다 | send→result(mid 상관)·ping→pong은 `Peer`에만 존재하고 실-ws+JSONTransport 경로에는 없다 (`socket.ts:459-475,816-824`, `README.md:117-118`) |
| 조건·결함 주입은 도구 측 데코레이터가 소유 | 실-ws 경로의 지연·지터·순서섞임·유실·변조·패킷 크기 가드(1009)는 `NetworkSupportable`을 감싸는 데코레이터가 **outbound에만** 적용한다 | owned ws의 `configure()`는 no-op (`websocket.ts:395-397`); 양 끝 동시 적용 시 왕복 지연이 2배가 된다 |
| 결함 가시화는 에코 왕복으로 고정 | 유실·변조의 관측은 단일 연결의 에코 왕복(송신 측 transport가 자기 에코를 재조립)에서 성립한다 | outbound 주입과 관측 지점을 같은 패널에 두어 관측 구성이 하나로 닫힌다 |
| 결함 탐지는 기존 에러 표면 소비 | 변조는 chunk data 페이로드만 손상시켜 `json.chunk.hash` 에러로 수렴시키고, 유실은 재조립 미완(대기 중→타임아웃)으로 드러낸다 — 도구는 새 탐지 로직을 만들지 않는다 | transport가 FNV-1a hash 검증과 partial TTL 정리를 이미 제공 (`transport.ts:491-497,182`); 손상 위치를 한정하면 탐지 경로가 하나로 수렴한다 |
| 실-ws 재연결은 네트워크 재생성 | 재연결 조작은 도구가 owned 네트워크를 닫고 새로 생성하는 것으로 정의한다 — 라이브러리의 `createReconnectingNetwork`는 검증하지 않는다 | 작성자 확정(2026-07-10); owned 네트워크 자체에는 재연결이 없다 (`websocket.ts:345-419`) |
| `src/socket` 무수정 소비 | 도구는 공개 API(`createPeer`/`createSocketFactory`/`createOwnedWebSocketNetwork`/`createFilteredNetwork`/`createJSONTransport`/`waitWebSocketConnectionId`/`extractWebSocketConnectionId`/`NetworkSupportable`)만 소비하고 라이브러리 코드를 변경하지 않는다 | 검증 도구가 검증 대상을 고치면 회귀 검증(00 목표)이 무의미해진다 |
| 루트 `demo/` 배치 + 실행 문서 포함 | 도구 전체는 lemon-model 루트 `demo/`에 두고 패키지 빌드·배포 산출물에 포함하지 않으며, 실행·검증 절차를 담은 문서를 함께 제공한다 | 작성자 확정(2026-07-10); "문서만 보고 실행·검증 도달"(00 목표 3)을 계약으로 보장 |

## 모델 계약

- **조건 모델**: `latencyMs`·`jitterMs`·`unordered`·`maxPacketBytes`·`dropRate`·`corruptRate`를 숫자/불리언 값으로 지정한다. 같은 값을 다시 지정하면 같은 설정이 재현된다(시퀀스 재현 아님 — 00 비목표).
  - in-memory 경로: `latencyMs`·`jitterMs`·`unordered`·`maxPacketBytes`는 기존 `configureNetwork()`가 적용한다 (`socket.ts:360-369`). `dropRate`·`corruptRate`는 미제공.
  - 실-ws 경로: 여섯 조건 전부 도구 측 데코레이터가 적용한다. `corruptRate`의 손상 대상은 chunk data 페이로드로 한정한다(핵심 결정 4).
  - 조건 변경은 즉시 반영된다. 패킷 크기 판정은 전송 시점 기준이고, 지연은 아직 배달되지 않은 패킷에도 새 값이 적용될 수 있다 (`socket.ts:190,246,361`).
- **타임라인 이벤트 모델**: 모든 이벤트는 최소 `시각`·`연결 식별자`·`방향(in/out)`·`종류`·`상세`를 담고, 발생 순서대로 단일 타임라인에 쌓인다.
- **재조립 상태 모델**: 재조립 미완 메시지는 `대기 중` 상태로 노출되고, TTL 만료 시 `json.partial.expired` 이벤트로 `타임아웃`으로 전환된다.
  - 타임아웃 이벤트는 `cleanup()`이 실행될 때만 발생하므로 (`transport.ts:394-411`, 기본 `cleanupIntervalMs: 0` — 자동 타이머 없음), 도구는 **`cleanupIntervalMs`를 양수로 설정**(또는 주기적으로 `cleanup()` 호출)하고 `partialTtlMs`를 관측 가능한 짧은 값으로 설정한다.
  - `대기 중`의 식별은 `pendingCount`(`transport.ts:325-328`)와 tid가 담긴 transport 이벤트 스트림을 도구가 재구성해 제공한다 — 공개 API는 개별 대기 메시지 목록을 주지 않는다.
- **시나리오 재실행 모델**: 회귀 확인(00 목표 4)은 조건값 재입력 + 문서화된 절차의 수동 재현으로 정의한다. 시나리오 저장·재생 기능은 두지 않는다.

## 서버 보장

로컬 mock 서버(실-ws 경로 전용)는 다음을 보장한다.

- 로컬 프로세스로만 동작하고 외부 인프라·배포·인증을 요구하지 않는다.
- connectionId는 클라이언트의 connect 핸드셰이크 프레임에 대한 **응답으로만 발급**한다. 포맷은 `extractWebSocketConnectionId()`가 인식하는 형태를 따르고 (`websocket.ts:83-99`), connect 프레임 자체는 에코·중계 대상에서 제외해 `waitWebSocketConnectionId()`(`websocket.ts:105-159`)가 자기 에코를 connectionId로 오인하지 않게 한다. 응답 발급이므로 클라이언트 구독 전에 프레임이 도착하는 레이스가 없다.
- 수신한 텍스트 프레임을 발신 연결로 에코해 왕복을 성립시키고, 다른 연결이 있으면 그쪽에도 중계한다.
- 텍스트 프레임만 처리하고 바이너리 프레임은 조용히 무시한다.
- 서버는 connect 핸드셰이크 프레임의 식별을 제외하면 메시지 내용을 해석·변형하지 않는다 — 조건·결함 주입은 클라이언트 측 데코레이터 소유(핵심 결정 2).

## 클라이언트 동기화 계약

브라우저 검증 UI는 다음을 보장한다.

- 관측 가능한 모든 이벤트(송수신·연결·핸드셰이크·종료·재연결·에러·청크 분할/재조립·대기/타임아웃)를 발생 즉시 타임라인에 추가한다.
- 종료와 에러를 구분해 표시한다 — owned 어댑터는 둘 다 `onError`로 표면화하므로 `WEBSOCKET_NETWORK_SCOPE`의 close scope(`websocket.ts:62-67,334-343`)로 식별한다.
- transport 에러 이벤트를 정상 흐름과 시각적으로 구분해 표시한다. 표시 대상 scope: `json.send`(1009 크기 가드 위반 포함, `transport.ts:331-349`), `json.chunk.hash`, `json.manifest.duplicate`, `json.chunk.duplicate`, `json.chunk.ref`, `json.chunk.total`, `json.parse`, `json.packet`, `json.partial.expired` (`transport.ts:394-585`).
- 메시지 전송·연결 닫기/재연결·조건 변경을 화면에서 즉석 수행할 수 있다.
- 연결이 여러 개일 때 각 이벤트가 어느 연결의 것인지 식별된다 — 단일소켓 클라이언트 여러 개는 범위 안이고, 클라이언트당 다중 연결(듀얼소켓)만 범위 밖이다.

## Out of Scope

- 클라이언트당 다중 연결(듀얼소켓) 검증 — 다음 버전.
- 실서버(WSS API) 연동 검증.
- CI·vitest 등 자동화 테스트 대체.
- 패킷 유실·변조로부터의 복구(재전송·ACK) — 탐지 가시화까지만.
- 확률적 조건의 시드 고정 시퀀스 재현.
- in-memory 경로에의 결함주입(`dropRate`·`corruptRate`) 제공.
- 시나리오 저장·재생 기능.
- 라이브러리 재연결 데코레이터(`createReconnectingNetwork`) 검증.
- 바이너리 프레임 검증 — 서버·클라이언트 어댑터 모두 non-string을 조용히 무시한다 (`websocket.ts:178,331`).
- `src/socket` 라이브러리 코드 수정.

## 재검토 조건

- 듀얼소켓(v2) 검증을 시작할 때 — 두 검증 경로 분리·타임라인 이벤트 모델 재검토.
- 실서버(WSS API) 연동 요구가 생길 때 — 서버 보장 전체 재검토.
- `src/socket`에 재전송·ACK가 도입될 때 — 결함 탐지 계약(복구 Out of Scope) 재검토.
- JSONTransport 에러 scope 체계가 변경될 때 — 클라이언트 동기화 계약의 표시 대상 목록 갱신.
