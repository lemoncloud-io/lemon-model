# Review: socket-visual-verifier

**Status:** Confirmed
**Date:** 2026-07-10
**Slug:** socket-visual-verifier
**Plan:** [03-plan.md](./03-plan.md)

**Score:** 9/10 (라운드 1: 8/10 Changes Requested → 수정 3건 반영 → 라운드 2: Approved)
**검증 실행:** demo `npx vitest run` 27/27 · `npx tsc --noEmit` 클린 · `npx vite build` 성공 · 루트 `npm test` 215/215(무오염) · `git status` demo/ 밖 무변경

## 목표 / 요구사항 충족

| 항목 (00-requirement: 요구사항·목표) | 결과 |
|---|---|
| R1 기본 왕복(send→result·ping→pong) 확인 | 충족(로직) — `tests/peer-session.spec.ts` mid 상관 검증. 화면 육안은 미검증 |
| R2 청크 분할·재조립 과정 확인 | 충족(로직) — `tests/ws-session.spec.ts` chunk-out N회→assemble |
| R3 수명주기 5종(연결·핸드셰이크·종료·재연결·에러) | 충족 — 모드 B 4종 + 에러(라운드 1 Critical 수정으로 모드 A 발행 실패도 severity error로 표시) |
| R4 지연·지터·순서섞임 하 동작 유지 | 충족 — 데코레이터 단위 테스트 + Playwright e2e(latency 500·jitter 300·unordered에서 연속 5건 send 전부 result 상관) |
| R5 유실·변조 → 재조립 실패·에러가 구분되어 타임라인 표시 | 충족(로직) — drop→pending→expired, corrupt→`json.chunk.hash`, 모두 severity error |
| R6 재조립 미완의 대기·타임아웃 표시 | 충족(로직) — pendingCount diff→pending 파생 + expired 이벤트 |
| R7 실제 WebSocket 전송 왕복 검증 | 충족 — ws-session 테스트 전체가 실 ws 서버 경유 |
| R8 화면 즉석 조작(전송·닫기/재연결·조건) | 충족 — Playwright가 실제 UI 조작으로 전 시나리오 수행(2026-07-10, 13/13 PASS) |
| R9 시간순 타임라인 + 연결 구분 | 충족(로직) — seq 단조 증가 테스트, 연결별 배지. 렌더 육안 미검증 |
| R10 조건값 숫자 지정·재지정 재현 | 충족 — 순수 숫자/불리언 조건 모델 |
| G1 검증 대상 전부 브라우저 타임라인 육안 확인 | 충족 — Playwright + 스크린샷 판독으로 5개 시나리오 전부 타임라인에서 확인(기본 왕복 mid 상관·chunk 0/5~4/5→assemble·handshake/close/reconnect·악조건·drop→pending→expired·corrupt→json.chunk.hash) |
| G2 계약 위반 순간의 시각적 구분 | 충족 — 스크린샷에서 severity=error 행(1009·hash mismatch·expired)이 빨간 배경으로, drop/corrupt/chunk-out이 별도 강조색으로 정상 흐름과 구분됨을 판독 확인 |
| G3 문서만으로 실행·검증 도달 | 충족 — README 시나리오 표의 절차·기대 시퀀스만으로 Playwright 스크립트를 작성해 13/13 재현 성공(문서 충분성의 실증) |
| G4 src/socket 수정 → 재검증 루프 | 충족 — vite alias로 빌드 없이 직접 컴파일 + vitest 27개 회귀 가드 |

## 이슈

- **Critical** — (해소) 모드 A 발행 실패가 성공처럼 표시: `peer.publish`의 `level==='error'` 로그를 성공과 동일 매핑 + client peer `onError` 미구독. → level 분기 매핑(sys/error) + client.onError 구독 + 회귀 테스트 추가로 해소(라운드 2 실측 확인).
- **Improvement** — (해소) 내부 모듈 직접 import(`@socket/socket`) → 문서화된 진입점 `@socket/testing`으로 변경. / (해소) 모드 B 1009 에러 이벤트 중복 → `doSend()` 재throw 제거로 onError 경로 단일화 + "정확히 1개" 회귀 테스트.
- **Critical (육안 검증에서 발견, 해소)** — 초기 화면 전체 공백: `App.tsx:25`가 `useSyncExternalStore`에 store 클래스 메서드를 detached로 전달 → `this` 유실 TypeError로 첫 렌더 크래시. `subscribe`/`getSnapshot`을 화살표 클래스 프로퍼티로 전환 + detached 호출 회귀 테스트 추가로 해소(vitest 28/28).
- **Note (잔여, 수용)** — ① `queueMicrotask` 기반 pendingCount 읽기: transport 내부 동기 실행 순서 의존(코드 주석으로 위험 명시). ② `ChunkPacket` 로컬 재정의: transport 패킷 필드 변경 시 조용히 어긋날 수 있음. ③ 모드 A post/ping 실패 시 에러 이벤트 2건 중복(라벨은 정확 — 오도 없음). ④ `doSend()` catch가 `splitJSON` 유래 예외를 삼킬 수 있는 이론적 은폐 경로(현 데모 입력으로는 도달 불가, `transport.ts:331-349`의 emitError 커버리지 밖 예외가 원인).

## use-case 패턴 체크 (proxy-implementation-guide §9)

USE-CASE.md 예외 조항 적용(브라우저 데모 도구 — use-case lib 구조 없음). 대신 01-spec 계약 준수를 검증:

- [x] 두 검증 경로 분리(A: send/result/ping, B: 청크/수명주기/결함)
- [x] 조건·결함 주입 outbound 데코레이터 소유(전체 멤버 위임 패턴)
- [x] 결함 가시화 에코 왕복 / 변조 chunk data 한정·hash 불변(실 transport 회귀 가드)
- [x] cleanupIntervalMs>0 설정·재연결=스택 재생성·서버 무해석(connect 식별 제외)
- [x] `src/socket` 무수정·공개 API만 소비·루트 무오염(jest 글롭 실측 회피)
- [x] Out of Scope 10항 침범 없음

## 개선 항목

- [x] 모드 A 발행 실패 가시화 (Critical — 5↔6 루프 1회차에서 해소)
- [x] `@socket/testing` 진입점 정합
- [x] 1009 에러 이벤트 중복 제거
- [x] 실측 왕복 지연(Δms) 표기 추가(사용자 요청, 2026-07-10) — 모드 A `result`/`pong`(mid 상관)·모드 B `assemble`(tid 상관)에 `meta.elapsedMs` + detail `(+Nms)`. vitest 28/28·Playwright 실측 3/3 확인
- [ ] 잔여 Note 4건 — 차기 유지보수 시 참고(현재 동작 결함 아님)
- [x] 브라우저 육안 검증(G1·G2·R8) — Playwright로 README 시나리오 13건 수행·스크린샷 판독(2026-07-10). 잔여 cosmetic: expired 이벤트 detail에 scope 문자열이 두 번 표기됨(`json.partial.expired — json.partial.expired`)

## 잘된 점

- 변조 회귀 가드가 fake가 아닌 **실제 `createJSONTransport` 왕복**으로 `json.chunk.hash` 발화를 검증.
- drop/expire 테스트가 `Math.random` 스파이로 "manifest 통과·complete만 유실"을 결정론적으로 재현하고 축소 TTL로 타임아웃까지 검증.
- mock 서버가 `src/socket` 비의존·connect 프레임 relay 차단으로 자기 에코 오인 원천 차단.
- in-memory 경로에 dropRate/corruptRate 미적용 + UI 비활성의 이중 방어.
- `tests/`(복수형) 배치의 근거가 02-design 폐기안에 실측과 함께 문서화됨.
