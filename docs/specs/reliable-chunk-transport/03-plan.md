# Plan: reliable-chunk-transport

**Status:** Confirmed
**Date:** 2026-07-13
**Slug:** reliable-chunk-transport
**Spec:** [01-spec.md](./01-spec.md)
**Design:** [02-design.md](./02-design.md)

## 참조

- `src/socket/transport.ts:299-` → JSONTransport 클래스(수정 대상). 468행 부근 완성 즉시 `states.delete`, 478/505행 부근 duplicate 에러 가드 — 신뢰 모드 분기의 핵심 지점
- `src/socket/transport.ts:217,271` → `splitJSON`/`assembleJSON` — 재사용, 재분할 금지 원칙의 대상
- `src/socket/socket.ts:874-878` → `Peer.sendToLink`(splitJSON 직접 호출 — senderTransport 분기 삽입 지점), `:611-625` attachReceiver, `:673-695` createNetworkPair(uplink/downlink), `:846-872` reply
- 02-design "Peer 통합" 절의 **connect() 배선 매핑표** — 구현 시 코드 주석으로 그대로 옮길 것(뒤집힘 = 에러 없는 hang)
- `jest.config.json` → testMatch `**/src/**/*.spec.ts`. demo 하위에 spec 파일 금지
- `src/socket/testing.ts` → 인메모리 시뮬레이터(createNetwork·createPeer) — spec에서 유실 주입은 네트워크 얇은 drop 래퍼로

## 작업 단위 (의존 순서)

1. **transport.ts — 타입·골격** (동작 변경 없음)
   `ReliableOptions`(+`receiveNetwork`), `JSONTransportOptions.reliable`, `JSONAckPacket`/`JSONNackPacket`+유니온·`isJSONTransportPacket` 확장(presence 검사·미지 필드 무시·`v` 예약), `JSONTransportReliableError{tid}`, `defaultReliableJSONTransportIdentityProvider`(randomUUID typeof 가드→타임스탬프+랜덤 폴백).
   — **검증:** `npm run lint` + 기존 `transport.spec.ts` green(분기 미사용이므로 무영향 확인).

2. **transport.ts — 신뢰 모드 송신측**
   `send()` 신뢰 분기: `splitJSON()` **1회** 호출·결과를 `pendingSend`에 원본 보관(재분할 금지), 초기 전송, `resendIntervalMs` 블라인드 재전송(readyState tick-skip, 초기 동기 실패도 skip 흡수·재throw 없음), `json:nack` 수신 시 결측만 재전송, `json:ack` 수신 시 settledSend 기록·resolve, `maxAttempts` 소진 시 `json:error` best-effort+settled(fail)+reject+onError, self-catch(원본 Promise 반환).
   — **검증:** 4번 spec의 송신 시나리오로 커버(단계 종료 시 해당 it green).

3. **transport.ts — 신뢰 모드 수신측 + 정리**
   settled 조기 반환(ok→재-ack, fail→조용히 폐기), duplicate idempotent 완화(신뢰 분기에서만 — 기존 라인 치환 금지, 이른-return 삽입), `json:nack` debounce 발송(패킷 도착마다 리셋, 현재 상태 diff 재계산), 완성 시 settledReceived+`json:ack` 회신, `json:error` 수신 시 부분 버퍼 폐기+settled(fail)+onError, `cleanup()` 확장(settled 두 맵 TTL+maxEntries 스윕), `receiveNetwork` 구독 분기, 모드 불일치 가드(`!reliable`+ack/nack→`json.reliable.mismatch`), 제어 패킷은 acceptPacket 최상단 분기 후 즉시 return, `detach()` 멱등화+타이머 정리.
   — **검증:** 4번 spec 수신 시나리오 커버 + `npm run lint`.

4. **transport.spec.ts — `describe('reliable mode')` 추가**
   시나리오: ① 정상(소·대 페이로드) ② 유실→NACK 선택 복구(결측만 재전송 확인) ③ 전 프레임 유실→블라인드 폴백 ④ 복구 불능→양측 실패 통지·부분 상태 폐기 ⑤ ack 유실→settled 재-ack 수렴(onMessage 1회 보장) ⑥ 재연결 tick-skip(maxAttempts 미소진) ⑦ settled TTL·maxEntries 만료 ⑧ 미지 필드 패킷 수용(forward-compat) ⑨ fire-and-forget 시 unhandled rejection 부재 ⑩ 재분할 없음(재전송에서 동일 tid·cid 유지) ⑪ 모드 불일치 양방향(`json.reliable.mismatch`) ⑫ 손상 청크(hash 불일치)→누락 취급→NACK 복구(무결성 계약). 타이머 옵션은 수 ms로 주입(기존 spec 관례).
   — **검증:** `npx jest --config=jest.config.json src/socket/transport.spec.ts` 전체 green — **기존 off 시나리오(중복=에러 검증 포함) 무손상이 게이트**.

5. **socket.ts — Peer 통합**
   `PeerLink.senderTransport`(reliable on이면 receiverTransport와 동일 인스턴스), `attachReceiver`→`attachTransport` 확장(local options의 reliable truthy면 writeNetwork 위 병합 인스턴스+`receiveNetwork=readNetwork`, off면 기존 경로 무변경), `connect()`/`reconnectPair()` 배선을 02 매핑표대로(표를 주석으로 복사), `closeLink()` 멱등 detach, `sendToLink()` senderTransport 우선 분기(기존 분기 무변경), `publish()`·`reply()`의 sendToLink 호출에 `await` 추가, 전송 실패 시 `pending(mid)` fail-fast reject.
   — **검증:** 기존 `socket.spec.ts` 전체 green(off 회귀 — 특히 동기 실패 시나리오 :292-314) 확인 후 6번으로. 기존 spec에 post 연속 발행 순서·동기 실패의 명시 단언이 없으면 **off 경로 회귀 단언을 먼저 보강**한 뒤 await 변경을 적용(마이크로태스크 지연 회귀를 테스트로 고정).

6. **socket.spec.ts — 신뢰 Peer 시나리오 추가**
   ⑬ 정상 왕복(전송 ack+응답 result) ⑭ send() 전송 실패 fail-fast reject ⑮ post() 실패 onError 통지 ⑯ 링크 재연결 시 진행 중 송신 실패 종결 ⑰ 한쪽만 옵트인 시 모드 불일치 전파.
   — **검증:** `npm test` 전체 green + `npm run test:package-exports`.

7. **demo/socket-verifier 확장 — 육안 검증**
   기존 JSONTransport 세션에 `reliable: true` 토글, 유실 주입(conditioned-network)으로 ②③④ 재현, TimelineLog에 ack/nack·복구·실패 통지 표시. **선행 확인:** 데모 mock 서버의 송신자 포함 브로드캐스트는 유니캐스트 전제를 깨므로 보정 필요 — 구현은 기존 시나리오(self-echo 의존)를 보존하기 위해 connect 프레임의 `unicast: true` **옵트인 플래그**로 분리(미지정 시 기존 동작 불변), reliable 세션만 이 플래그로 접속. demo 하위 spec 파일 금지.
   — **검증:** 브라우저에서 유실 주입→완성본 조립, 복구 불능→실패 통지, 자기 에코 부재를 육안 확인(00 목표). mock 서버 송신자 제외 보정이 기존 verifier 데모 기능(브로드캐스트에 의존하던 시나리오)에 회귀를 만들지 않는지 함께 확인.

8. **문서 동기화·마감**
   00 목표 항목별 충족 확인, 구현 중 01/02와 어긋남 발생 시 해당 게이트 재통과 후 반영, auto memory 학습 1줄.
   — **검증:** `npm test && npm run lint` 최종 green.

순서 근거: 1→2→3은 transport 내부 의존, 4가 transport 계약 회귀의 본체, 5·6은 transport green 이후(Peer가 신뢰 transport에 의존), 데모(7)는 라이브러리 완성 후. 각 단계 독립 커밋 가능.

## 리스크 / 롤백

| 리스크 | 대응 |
|---|---|
| off 경로 회귀 — duplicate 에러 가드·완성 즉시 delete 지점을 건드리는 diff | "조건 수정 금지, 신뢰 분기 이른-return 삽입만" 원칙(02 결정 ①). 기존 spec의 중복=에러 시나리오가 회귀 게이트 |
| `publish()`/`reply()` await 추가가 off 경로에 마이크로태스크 지연 유발 | 검증된 안전 지점(동기 throw 경로는 _deliver 밖, 기존 테스트는 wait 후 단언) — 5단계에서 기존 socket.spec 전체로 확인 |
| connect()/reconnectPair() 배선 뒤집힘 — 에러 없이 hang | 02 매핑표를 코드 주석으로 강제 복사 + ⑫ 정상 왕복 spec이 즉시 잡음 |
| 옵션 재배정(병합 인스턴스는 자기 옵션) 분기를 off 경로에 흘림 | reliable on에만 적용, off는 기존 관례(상대 옵션) 유지 — diff 리뷰 체크 항목 |
| 재전송 타이머·debounce로 spec flaky | 타이머 옵션 수 ms 주입 + 기존 spec 대기 헬퍼 관례 |
| 에코백·브로드캐스트 릴레이 위 오동작 | 유니캐스트 전제(01 계약)·JSDoc 명시, 데모 서버 송신자 제외 보정(7단계) |
| N연결 상시 서버의 settled·타이머 부하 | `settledTtlMs`/`settledMaxEntries` 연결당 하향 튜닝 지침 JSDoc 명시 |
| 롤백 | transport.ts·socket.ts 수정이 신뢰 분기 삽입 위주라 revert 단순. 단계별 독립 커밋으로 부분 롤백 가능 |
