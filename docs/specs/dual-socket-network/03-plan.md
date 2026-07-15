# Plan: dual-socket-network

**Status:** Confirmed
**Date:** 2026-07-13 (초판 dual 고정 기준 → N개 일반화 개정 반영. 초판 플랜은 dual.ts 기준으로 이행 완료 후, 개정에서 multi.ts로 교체됨)
**Slug:** dual-socket-network
**Spec:** [01-spec.md](./01-spec.md)
**Design:** [02-design.md](./02-design.md)

## 작업 단위 (의존 순서)

USE-CASE.md 빌드 순서 규약은 예외 조항 적용(저수준 라이브러리 모듈) — [02-design.md](./02-design.md)의 모듈 분해를 따른다.

1. `src/socket/multi.ts` — 타입(`MultiSocketErrorContext`·`MultiNetworkSupportable`·`MultiSocketNetworkFactory`)·`MULTI_NETWORK_SCOPE`·`MultiSocketNetwork`·`createMultiSocketNetwork`(배열/count 오버로드, count 검증은 팩토리 호출 전). 02의 멤버별 위임 표를 그대로 구현 — **검증:** `npx tsc --noEmit` 클린(루트).
2. `src/socket/multi.spec.ts` — 02 검증 설계 17항목 + 팩토리 0회 호출 가드(fake 네트워크, in-memory Network 미사용) — **검증:** `npx jest src/socket/multi.spec.ts --coverage` 전부 통과, 라인 커버리지 100%.
3. `src/socket/index.ts` — `export * from './multi'` 한 줄 — **검증:** 루트 `npm test` 전체 통과(기존 기준선 215 + 신규, 기존 spec 무영향 확인).
4. `demo/socket-verifier/src/dual-session.ts` — ws 세션에 붙는 Dual 확장: 저수준 조각(`waitWebSocketConnectionId`·`createOwnedWebSocketNetwork`) 2세트 → `createMultiSocketNetwork([primary, secondary])` 합성(transport 미경유 병행 렌즈), mid 부여·receive/duplicate 파생·close 이벤트 직접 push·`network.multi.send` index 이벤트 변환 — **검증:** demo `npx tsc --noEmit` 클린.
5. `demo/socket-verifier/src/{types.ts,ws-session.ts,App.tsx,ConnectionPanel.tsx,TimelineLog.tsx}` — ws 패널 Dual 토글·P/S 배지·Send Both·Close Primary/Secondary·secondary URL 필드·세대 가드(02 동시성 방어). 기존 모드 코드 경로 무영향 — **검증:** demo `npx vitest run` 기존 28개 전부 통과(회귀 없음).
6. `demo/socket-verifier/tests/dual-session.spec.ts` — 확장 로직 검증(mid 파생·sendAll 실패 변환·격리·transport 무간섭·레이스 취소 경로). `tests/`(복수형) 배치 유지 — **검증:** demo `npx vitest run` 전체 통과.
7. `demo/socket-verifier/README.md` — Dual 시나리오 표(토글·Send Both 4건 조건·무간섭·정직한 실패·detach) — **검증:** 표의 절차만으로 브라우저(또는 Playwright) 재현 가능.
8. 통합 검증 — **검증:** 루트 `npm test` 전체(demo 테스트 미수집 확인 포함) + demo `npx vitest run`·`npx tsc --noEmit`·`npx vite build` + 브라우저 육안(README Dual 시나리오 전 항목).

순서: 1 → 2 → 3 → 4 → {5, 6} → 7 → 8. 라이브러리(1~3)가 선행 — demo(4~)는 vite alias `@socket`으로 `src/socket`을 직접 소비하므로 3의 export가 전제.

## 리스크 / 롤백

- **fake 네트워크가 계약 항목과 어긋나 spec 재작업** → fake는 multi.spec.ts 파일 안에 최소 구현으로 두고 계약 항목에서 역산한다. 완화: 02 검증 설계가 항목을 이미 고정.
- **루트 오염** — root `package.json`·기존 spec 파일 수정 금지(01 무파손). demo 의존성 추가가 필요하면 demo `package.json`에만.
- **jest 수집 경계** — `multi.spec.ts`는 `src/**` glob의 정식 수집 대상(의도), demo 신규 테스트는 `tests/`(복수형)에만 두어 루트 jest에 잡히지 않게 한다(`**/test/**` 글롭 함정).
- **mock 서버 크로스토크** — 전역 브로드캐스트라 다른 패널이 붙어 있으면 수신 건수가 4건(2소켓 구성)을 초과. README 시나리오에 "패널 단독일 때" 조건을 명시하고, Playwright 재현도 단독 상태로 수행.
- **롤백** — 라이브러리: `multi.ts`·`multi.spec.ts` 삭제 + `index.ts` 한 줄 revert = 완전 롤백. demo: `dual-session.ts`·`tests/dual-session.spec.ts` 삭제 + UI 파일 diff revert. 두 축이 독립적이라 부분 롤백 가능.
