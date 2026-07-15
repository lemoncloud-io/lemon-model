# Plan: socket-visual-verifier

**Status:** Confirmed
**Date:** 2026-07-10
**Slug:** socket-visual-verifier
**Spec:** [01-spec.md](./01-spec.md)
**Design:** [02-design.md](./02-design.md)

> USE-CASE.md 빌드 순서 규약은 예외 조항 적용(브라우저 도구) — [02-design.md](./02-design.md) 모듈 분해의 의존 순서를 따른다. 모든 파일은 `demo/socket-verifier/` 하위 신규이며 루트·`src/**`는 건드리지 않는다.

## 작업 단위 (의존 순서)

1. **스캐폴딩** — `package.json`(react·vite·ws·typescript·vitest) · `start.cjs`(chatic 복제 + `VITE_DEMO_WS_URL` 주입) · `vite.config.ts`(alias `@socket` → `../../src/socket`, `fs.allow: ['../..']`) · `tsconfig.json` · `index.html` · 빈 `App.tsx`
   - **검증:** `npm install && npm run start` → 2-프로세스 로그(포트 자동탐색 포함) + 브라우저 빈 화면. `@socket` alias로 `types.ts` import가 컴파일되는지 확인. 저장소 루트 `npm test`가 기존과 동일하게 통과(demo 미간섭 기준선).

2. **mock 서버** — `mock-server.mjs`: accept → connect 프레임(`{"action":"connect"}`) 수신 시 `{"connectionId":"conn-..."}` 응답 → 그 외 텍스트 에코+타 연결 중계 → 바이너리 무시
   - **검증:** `tests/mock-server.spec.ts`(vitest, node env) — 임의 포트로 서버 기동 후 `ws` 클라이언트로 ① connect→connectionId 수신 ② 텍스트 에코 ③ 2연결 중계 ④ connect 프레임 비에코 ⑤ 바이너리 무응답.

3. **조건 데코레이터** — `src/conditioned-network.ts`: outbound 지연·지터·재정렬·유실·변조(`type==='json:chunk'`의 `data`만, `hash` 불변)·1009 가드 + tap 콜백
   - **검증:** `tests/conditioned-network.spec.ts` — fake `NetworkSupportable`로 ① latencyMs 지연 ② 재정렬 ③ dropRate=1 폐기+tap ④ 1009 throw ⑤ 변조 후 실제 `createJSONTransport` 왕복에서 `json.chunk.hash` 발화(01 핵심 결정 4의 회귀 가드).

4. **상태 스토어** — `src/verifier-store.ts`: `ConnectionState[]` + `TimelineEvent[]`, subscribe, `pendingCount` diff → `pending` 이벤트 파생
   - **검증:** `tests/verifier-store.spec.ts` — seq 단조 증가·상태 전이·pending 파생.

5. **모드 A 세션** — `src/peer-session.ts`: `createSocketFactory`/`createPeer`(jsonTransport 미사용), ping=`send({type:'ping', data})`, 주입 logger → TimelineEvent 변환
   - **검증:** `tests/peer-session.spec.ts`(in-memory라 node로 충분) — send→result 상관, ping→pong, reconnect, `configure` 이벤트, unordered 시 jitter≥1 강제.

6. **모드 B 세션** — `src/ws-session.ts`: 02-design 배선 순서(raw ws 핸드셰이크 → `socketFactory` 주입 → `createFilteredNetwork`(inbound `"type":"json:`만) → 조건 데코레이터 → `createJSONTransport({cleanupIntervalMs:1000, partialTtlMs:10000})`), 재연결=스택 재생성
   - **검증:** `tests/ws-session.spec.ts`(vitest, node env — 전역 `WebSocket`에 `ws` 주입, mock 서버 스폰) — ① 핸드셰이크로 connectionId 획득 ② 대용량 청크 왕복 재조립 ③ dropRate 주입 → pending → expired(테스트는 `partialTtlMs`/`cleanupIntervalMs` 축소 주입) ④ corrupt → `json.chunk.hash` ⑤ close/reconnect 이벤트 ⑥ connectionId 프레임이 `json.packet` 에러를 만들지 않음(FilteredNetwork 회귀 가드).

7. **UI** — `src/{App,ConnectionPanel,TimelineLog}.tsx` + `styles.css`: 모드 토글·패널 추가/제거·조건 슬라이더·send/post/ping·close/reconnect·공유 타임라인(severity 색 구분, 연결 badge)
   - **검증:** 브라우저 수동 — 모드 A/B 각 패널에서 00 검증 대상(기본 왕복·청크·수명주기·악조건 강건성·결함 탐지)의 기대 이벤트 시퀀스를 육안 확인.

8. **실행 문서** — `README.md`: 실행 절차 + 검증 대상별 기대 이벤트 시퀀스 표(01 핵심 결정 7)
   - **검증:** 문서 절차만 따라 처음부터 재실행(00 목표 3 리허설). 마지막으로 저장소 루트 `npm test` 재확인 + `git status`에 demo/ 밖 변경 없음.

의존: 1 → 2 → {3, 4 병렬} → {5, 6 병렬(6은 2·3 필요)} → 7 → 8. 데모 테스트 실행은 전부 `demo/socket-verifier/` 안에서 `npx vitest`.

## 리스크 / 롤백

- **vite alias로 상위 저장소 TS 컴파일 실패**(tsconfig 충돌 등) — 발생 시 sync-playground식 `dist/esm` import(02 폐기안 1)로 전환하고 `npm run build` 선행을 감수. 작업 1의 alias 컴파일 검증에서 조기 감지.
- **node 테스트에서 전역 WebSocket 주입 실패**(작업 6) — 해당 케이스만 브라우저 수동 검증(작업 7)으로 격하하고 spec은 스택 조립 단위 검증으로 축소.
- **transport/peer logger `location` 문자열 결합의 취약성**(02 명시) — 변환기를 세션 파일 내 한 곳에 격리하고 unknown location은 조용히 통과. `src/socket` 리팩터 시 일부 kind 소실은 허용 동작.
- **expired 관측 지연**(TTL 10s) — 데모 UI는 그대로(육안 관측 가능), 테스트는 축소값 주입.
- **chatic start.cjs 복제 시 스크립트명·env 불일치** — 작업 1 verify에서 즉시 노출.
- **롤백 일반**: 전 작업이 `demo/socket-verifier/` 하위 신규 파일이므로 디렉터리 삭제 = 완전 롤백(루트 무변경 계약 덕분에 부작용 없음).
