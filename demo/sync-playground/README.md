# sync playground

## 컨셉

`src/sync`(L3 socket client + L4 sync machine)의 동기화 의미론을 시각적으로 확인하는 브라우저 도구.

- 서버 없이 브라우저 안에서 전부 돌아간다 (spec과 같은 Peer 시뮬레이터가 서버 대역)
- 세 열이 인과 순서다: **Server Band**(변경 발생) → **Wire**(변경 흐름) → **Clients**(판정·수렴)
- 화면의 모든 값은 lemon-model 공개 계약의 관측값(onChange · wire envelope · 어댑터 순수 함수)에서 나온다
- npm 배포에는 포함되지 않는다 (`files` whitelist)

## 동기화 정책 — 누가, 무엇을 기준으로 트리거하나

| 트리거 | 주체 | 기준 |
| --- | --- | --- |
| **pull** | **서비스가 당긴다** (머신은 timer 없음) | ① `register()` 직후 initialPull(기본 on, 데모는 off) ② 수동 `handle.pull()` ③ `machine.tick()` = 등록된 전 타입 pull |
| **주기 tick** | 서비스가 `createSyncTicker`로 소유 | 간격은 서비스 정책(주입). 실패 시 간격 2배 backoff(상한 60s), 성공 시 원복. 진행 중 tick은 겹치지 않음 |
| **이벤트** | **서버가 push** | 클라이언트는 구독만 — 요청하지 않는다 |

**pull의 범위 기준**: `since = 워터마크`(타입별 단조값). 워터마크는 **pull로 반영한 모델의 max(versionOf)** 로만 전진하고 이벤트는 올리지 않는다 — 이벤트가 유실돼도 다음 pull이 그 구간을 반드시 다시 덮는 안전망. 따라서 **이벤트 유실의 복구 지연 상한 = tick 주기**이며, 이것이 ticker 간격을 정하는 실질 기준이다.

**반영 기준**: `versionOf(수신) > versionOf(로컬)`일 때만 반영(기본 축 updatedAt, 어댑터로 seq 등 주입 가능). 축값 없으면 무시, `deletedAt`은 판정 통과 시 제거. 동시 tick은 진행 중 pull에 합류해 중복 요청을 만들지 않는다.

## 목표

1. **판정 가시화** — 수신 모델이 반영됐는지/무시됐는지, 그 사유(stale/미소유/축값 없음)까지
2. **워터마크 안전망 확인** — 이벤트가 반영돼도 워터마크는 전진하지 않고, 다음 pull의 `since`로 증명됨
3. **멀티 클라이언트 수렴** — 같은 서버를 보는 N개 클라이언트가 같은 상태로 수렴하는 것
4. **장애 동작 확인** — error 응답·무응답(timeout)·backoff에서 스토어가 오염되지 않는 것

## 실행법

```bash
npm run build                # dist/esm 생성 (필수 선행)
npx serve .                  # 저장소 루트에서
# → http://localhost:3000/demo/sync-playground/
```

## 시나리오 — 프리셋 버튼을 순서대로

| 프리셋 | 확인할 것 |
| --- | --- |
| **01#1 단방향 e2e** | pull → 스토어 반영 → 이벤트 → tick 델타 → tombstone 제거 (전체 수명주기) |
| **01#2 판정 규칙** | 낮은/같은 버전 무시(사유 표기), 높은 버전 반영, 미소유 type 무시 |
| **01#3 pull 오류** | error 응답 → reject인데 스토어·워터마크 무변화. 동시 tick 2회에 pull은 1개 |
| **05#2 seq 축** | updatedAt 없는 모델이 seq 축(versionOf 주입)으로 동기화 |
| **05#4 안전망** ★ | seq 50 이벤트가 반영돼도 워터마크 유지 — Wire의 `since` 필이 증거 |
| **05#5 tombstone** | 축값 실은 tombstone은 삭제, 축값 누락은 조용히 무시(서버 계약 위반 시 동작) |

★ = 이 도구의 존재 이유. 워터마크가 이벤트로 전진하면 유실 이벤트를 pull이 영영 못 메운다.

### 수동 실험

- **수렴**: `+ 클라이언트` 2개 이상 → 모델 `전송` → 모든 카드 수렴, 워터마크는 각자 독립
- **장애**: `다음 pull에 error 응답` / `다음 pull 무응답` (5초 뒤 timeout → onError)
- **backoff**: ticker 1s + error 응답 반복 → Wire 상대 시간 간격이 2배씩 벌어짐
- **축 전환**: updatedAt ↔ seq — 전환 시 로컬 상태 리셋 (close 후 재등록 의미론)
- **실소켓**: URL 입력 → 관찰 전용 클라이언트. 실서버의 sync wire 계약 준수 검사용

판정 로그 각 행의 `← mid`로 Wire의 원인 봉투를 역추적할 수 있다.
설계·한계는 [docs/model-sync-client/06-playground.md](../../docs/model-sync-client/06-playground.md) 참조.
