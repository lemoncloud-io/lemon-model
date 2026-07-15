# Review: dual-socket-network

**Status:** Confirmed
**Date:** 2026-07-13
**Slug:** dual-socket-network
**Plan:** [03-plan.md](./03-plan.md)

**Score:** 100/100 (dual 초판: 8/10 → Approved → 95점 루프: 87 → 99 · N개 일반화: 90 → 100 · Sockets UX 개편: 78 → **100 Approved**)
**검증 실행:** 루트 `npm test` 18 suites / 233 tests 통과(기존 기준선 215 + multi 18, 기존 spec 무영향) · `multi.ts` 커버리지 Stmts/Funcs/Lines 100% · `npx tsc --noEmit` 클린 · demo `npx vitest run` 38/38 · demo `npx tsc --noEmit` 클린 · `npx vite build` 성공 · Playwright 실측 A~G + 스팟(밀림 케이스 재태깅 포함) 전부 PASS(재실행 `pw-verify/verify-multi.cjs`)

## 목표 / 요구사항 충족

| 항목 (00-requirement: 요구사항·목표) | 결과 |
|---|---|
| R1 소켓 2개 이상 동시 연결·URL 개별 지정 가능 | 충족 — `createMultiSocketNetwork(networks[])`(2개 미만 즉시 throw) + `{count, networkFactory}` 편의 생성(검증이 팩토리 호출보다 선행). demo에 secondary URL 필드 시연 |
| R2 첫 번째=메인·나머지=백업, 기본 전송은 메인만 | 충족 — `send`=networks[0], readyState/ready/onOpen 메인 기준. demo 기존 Send(transport)가 Dual 활성 중에도 메인 단독(무간섭 실측) |
| R3 호출 단위 전체 전송·중복 도착 정상 | 충족 — `sendAll` + Playwright B(2소켓 구성 수신 정확히 4건 = receive 1 + duplicate 3, 같은 mid). N=3 spec 케이스 포함 |
| R4 소켓 간 독립(단절·에러 상호 무영향) | 충족 — 격리 교차 spec(N=3 중간 소켓 close 포함) + Playwright D/E |
| R5 자동 장애 전환·메인 승격 없음 | 충족 — failover 로직 부재, 죽은 쪽 실패는 index 태그 에러로만 전파 |
| R6 중복 걸러내기·식별자 주입 안 함, 페이로드 키로 판별 | 충족 — 바이트 동일성 spec + demo mid 스킴 |
| R7 단절·에러의 소켓 출처 구분 | 충족 — onError index 태깅(구독 시점 판별, `ctx.network`=합성체 통일) + demo P/S 배지 |
| G1 전체 전송 중 한 소켓 강제 단절에도 나머지 무중단 | 충족 — Playwright D + N=3 spec |
| G2 전체 전송 사본들 동일 식별자 | 충족 — 동일 바이트 전송, 실측 mid 동일 |
| G3 기존 API 무파손(옵트인) | 충족 — `index.ts` 1줄 외 기존 파일 무수정, 기존 215 테스트 그대로 통과 |
| G4 demo/socket-verifier 육안 검증(N개 소켓·단독 송신·출처 구분) | 충족 — ws 패널 Sockets 섹션(S0 고정 + Add/Remove), 소켓별 단독 Send·Send All, 타임라인 S*k* 칩. Playwright: N=3 sendAll 9건(칩 균등 분포)·단독 send 3건·Remove 재번호 후 stale 칩 0건 |
| 비목표 미침범 (failover/승격·재전송/ACK·중복제거 대행·순서 재정렬·메시지 태깅·서버 변경·상위 통합·런타임 추가/제거) | 충족 — 코드 전역 검토 위반 없음 |

## 이슈 (전 라운드 누적, 전부 해소)

- **Critical (dual 라운드 1)** — `sendAll`(구 sendBoth) 로컬 에러 방출 중 소비자 핸들러 throw 시 무-throw 계약 파괴·다음 소켓 스킵 → 핸들러 호출 개별 try/catch + 회귀 테스트.
- **Critical (95점 루프)** — demo Dual 토글 비동기 attach가 Close/Reconnect와 경합 시 죽은/교체된 메인에 바인딩된 확장이 반영(고아 소켓·stale 배지) → `dualGenerationRef` 세대 가드 + pending 중 수명주기 버튼 비활성 + 회귀 테스트. 02에 동시성 방어 절.
- **Improvement (95점 루프)** — unsubscribe 경로 미검증 → 3건 추가, 라인 커버리지 100%. secondary URL 미시연 → 입력 필드 추가.
- **Improvement (N개 일반화 라운드)** — `{count, networkFactory}`가 count 검증 전에 팩토리를 호출(부작용형 팩토리면 고아 리소스) → 검증 선행으로 수정 + "count<2면 팩토리 0회 호출" 회귀 가드. 03-plan의 구 dual 심볼 잔재 → multi 기준 재서술 + 개정 이력 주석.
- **Critical (Sockets UX 라운드, 해소)** — removeSocket 후 생존 백업의 수신 태깅 클로저가 옛 index에 고정되어 같은 소켓이 행 라벨(신 번호)과 수신·close 칩(구 번호)으로 갈라짐(리뷰어 실측 재현). → splice 직후 생존 백업 전원을 새 배열 위치로 재구독 + socketIndex 값 단언 테스트(뮤테이션 검증·리뷰어 독립 재현·Playwright 밀림 케이스 실측 3중 확인). 02에 "재번호 일관성" 원칙 추가.
- **Note (잔여, 수용)** — ① `onMessage` 재구독 시 닫힌 메인이 throw하면 나머지 구독도 무산되는 경로(현 demo는 초기 1회 구독만). ② `multi.ts` 브랜치 커버리지 80.76%(optional-fallback 반대 분기 — 기존 데코레이터 관례와 동일한 저위험 잔여).

## 개정 이력

- **2026-07-13 (사용자 지시 ①)**: demo 별도 dual 모드(Mode C) 폐기 → 기본 ws 패널 Dual 토글 확장 + 이중 스택 병행 구조(transport는 메인 전용, 합성체는 raw 렌즈 — 무태깅 계약에서 transport를 합성체 위에 얹으면 중계 청크로 `json.manifest.duplicate`가 나는 실측 근거).
- **2026-07-13 (사용자 지시 ②)**: dual 고정(2개) → N개 일반화. `dual.ts` 삭제, `multi.ts`로 단일화(`createMultiSocketNetwork` 배열/count 오버로드, `sendAll`, index 태그). 미커밋 상태라 하위호환 부담 없이 표면 1개로 정리.
- **2026-07-13 (사용자 지시 ③, UX)**: demo Dual 토글 폐기 → Sockets 섹션(S0 고정 + Add/Remove로 N개, 소켓별 URL·단독 Send·Close). 특정 소켓 단독 송신은 주입 인스턴스 직접 `send`, 수신 출처는 인스턴스별 직접 구독 태깅(무태깅 병합 스트림 계약의 소비자 패턴 시연), 타임라인 전 이벤트에 S*k* 칩. 구성 변경은 합성체 재생성(계약의 공식 패턴). demo 테스트 34→38.

## use-case 패턴 체크 (proxy-implementation-guide §9)

USE-CASE.md 예외 조항 적용(저수준 라이브러리 모듈 + 브라우저 데모). 대신 01-spec 계약 준수를 검증:

- [x] `send`=메인 단독(throw 통과) / `sendAll`=호출 단위·무-throw(핸들러 throw 포함)·독립 시도·index 태그 에러
- [x] 생성 제약(2개 미만 throw, 검증이 팩토리 호출 선행) / count 팩토리는 소켓 생성 비소유
- [x] 프레임 무변조·식별자 미주입·중복 판별은 소비자 책임 / 수신 병합·재정렬 없음·readyState 무관 지속
- [x] close 멱등·전 소켓·명시적 close 무음 / 단일 소켓 종료=주입 인스턴스 직접 close / unsubscribe 전 경로 해지
- [x] 기존 파일 무수정(`index.ts` export 1줄 예외)·루트 무오염·demo 테스트 `tests/` 배치(jest 미수집)
- [x] Out of Scope 9항 침범 없음 — "transport 위 전체 전송 금지"가 demo 병행 구조로 준수됨

## 잘된 점

- 02 검증 설계 18항목(N=3 격리·팩토리 0회 호출 가드 포함)이 multi.spec.ts에 1:1 대응, 라인 커버리지 100%로 실증.
- dual→multi 전환에서 demo UI 파일들이 byte 단위 동일(리뷰어 md5 대조) — "표기만 바뀌고 동작 동일"이 구조로 증명됨.
- 편의 생성이 기존 `PeerNetworkFactory` 관용구와 동형이라 학습 비용 0, 생성 소유는 소비자에 유지되어 데코레이터 생태계 재사용.
- 롤백이 "파일 2개 삭제 + 1줄 revert"(라이브러리 축)로 완결되는 격리 구조 유지.
