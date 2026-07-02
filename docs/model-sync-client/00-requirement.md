# Requirement: 범용 모델 동기화 클라이언트

- Status: Draft
- Date: 2026-07-02
- Slug: model-sync-client

## 개요

- CoreModel을 상속한 도메인 모델을 웹소켓으로 서버에서 받아와 로컬에 최신으로 유지하는 범용 동기화 머신을 lemon-model에 만든다. 동기화는 서버→클라이언트 단방향(읽기 전용)이다.
- 동기화 머신이 핵심 산출물이고, 요청-응답과 라우팅을 맡는 클라이언트 runtime과 기존 socket 레이어(network·transport)는 이를 받치는 하위 레이어다.

## 용어 정리

이 트랙의 모든 문서와 대화는 아래 용어를 기준으로 쓴다.

- 동기화 머신 (sync machine): 도메인 모델 타입을 등록받아 서버 상태를 로컬에 최신으로 유지하는 최상위 모듈. 읽기 전용이며 timer를 갖지 않는다.
- 클라이언트 runtime (socket client): 봉투 단위의 요청-응답 추적(mid 매칭, timeout)과 type 라우팅을 맡는 레이어. 모델 의미를 모른다.
- 네트워크 (network): raw string send/receive 경계. `NetworkSupportable` 계약과 그 구현(WebSocket 어댑터, in-memory Network).
- transport: 큰 JSON payload를 패킷 제한에 맞게 chunk/재조립하는 기존 `JSONTransport` 레이어.
- 봉투 (envelope): wire를 오가는 메시지 단위. 기존 `SocketMessage { type, data, mid }`.
- 어댑터 (protocol adapter): 서비스가 주입하는 wire 규약 ↔ 도메인 모델 변환기. 머신은 어댑터 없이는 서버 규약을 모른다.
- tick: 동기화 머신에 pull을 시키는 외부 호출. 주기·방식은 서비스가 정하며 표준으로 고정하지 않는다.
- pull: 클라이언트가 워터마크 이후 변경분을 서버에 요청해 받아오는 동작.
- 이벤트 (event): 서버가 요청 없이 밀어주는 변경 통지. pull과 함께 단방향 동기화의 두 수신 경로다.
- 워터마크 (watermark): 타입별로 로컬에 반영된 서버 확정 상태의 최대 updatedAt. 단조 증가하며 pull의 since 인자가 된다.
- 최신 판정: 수신 모델을 로컬에 반영할지 updatedAt 비교로 정하는 규칙.
- 핸들 (handle): `register()`가 돌려주는 타입 1개 분량의 동기화 조작 창구(get/list/pull/onChange).

## 해결하려는 문제

- 각 마이크로서비스와 프론트엔드가 웹소켓 연결과 모델 동기화를 각자 따로 구현하고 있다.
- chatic client-socket-v2는 chatic 도메인에 얽혀 있어 다른 서비스가 가져다 쓸 수 없다.
- 기존 구현은 네트워크·transport·동기화 책임이 한 덩어리로 섞여 있어 테스트와 교체, 확장이 어렵다.

## 목표

- 웹소켓 위에 네트워크, transport, 클라이언트 runtime, 동기화 머신으로 레이어를 나누고 각 레이어의 역할과 책임을 분리한다.
- 클라이언트 runtime은 요청-응답 추적과 메시지 라우팅을 책임진다.
- 동기화 머신은 CoreModel을 상속한 도메인 모델(예: UserModel)을 등록하는 것만으로 동작한다.
- 서버 메시지 프로토콜은 머신에 하드코딩하지 않고, 각 서비스가 어댑터로 주입한다.
- 동기화는 서버→클라이언트 단방향(읽기 전용)으로 동작한다. 서버 변경을 로컬 모델에 반영하며, 로컬 변경을 서버로 되보내지 않는다.
- tick(정보 교환 주기·방식)은 표준으로 고정하지 않는다. 서비스마다 달라질 수 있다.
- 모델의 최신 여부는 CoreModel의 updatedAt을 기준으로 판정한다.
- 서버가 상태의 유일한 원천이다. 클라이언트는 동기화 대상 모델을 로컬에서 직접 변경하지 않는다.
- 여러 모듈이 1개의 웹소켓을 공유하는 환경에서 동작한다. 같은 소켓 위의 JSON Transport, Progress와 간섭 없이 공존한다.
- 패킷 사이즈 제한(기본 64kb, 설정 가능)을 지킨다.
- 1차 실행 환경은 브라우저다.
- chatic client-socket-v2의 체계는 참고만 하고, 설계는 새로 한다. 기존 migrate-socket 트랙과는 독립으로 진행한다.

## 통과/검증 조건

- Peer simulator 위에서 예제 도메인 모델의 단방향 동기화 시나리오(pull과 이벤트 수신)가 테스트로 통과한다.
- 1개 소켓 위에 동기화 머신과 JSON Transport, Progress를 함께 올린 공존 시나리오가 테스트로 통과한다.
- 상위 서비스가 CoreModel 상속 모델 정의와 프로토콜 어댑터 주입만으로 동기화를 붙일 수 있다. lemon-model 코드를 수정할 필요가 없다.

## 비목표

- 쓰기 동기화(로컬 변경을 서버로 push)는 다루지 않는다. 필요해지면 후속 단계에서 별도 설계한다.
- chatic client-socket-v2를 이 모듈로 전환하는 마이그레이션은 하지 않는다.
- localStorage/IndexedDB 같은 오프라인 저장과 복구는 다루지 않는다.
- 동기화 서버(백엔드) 구현은 범위 밖이다.
- React hooks 같은 UI 프레임워크 연동은 상위 패키지로 넘긴다.
- 재연결·keep-alive는 1차에서 제외하고, 확장 지점만 설계에 남겨 후속 단계에서 더한다.
- Node/서버 런타임 지원은 이번 범위에서 우선하지 않는다.
