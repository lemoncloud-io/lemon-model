# socket-visual-verifier

## 목적

`lemon-model`의 `src/socket`이 약속하는 전송 계약(send→result 상관, ping→pong, 청크 분할·재조립, 수명주기, 악조건 강건성, 결함 탐지)을 로컬 브라우저에서 실시간 타임라인으로 눈으로 확인하는 시각 검증 도구다. 계약의 세부 내용은 [`docs/specs/socket-visual-verifier/01-spec.md`](../../docs/specs/socket-visual-verifier/01-spec.md)를 참고한다.

## 실행

```sh
cd demo/socket-verifier
npm install
npm run start
```

`npm run start`는 mock WebSocket 서버와 vite dev 서버를 함께 띄운다.

- 두 서버 모두 기본 포트(`DEMO_WS_PORT=8788`, `DEMO_HTTP_PORT=5173`)가 사용 중이면 **자동으로 다음 포트를 탐색**한다. 콘솔에 실제로 사용된 포트가 `[start] mock ws port=...` / `[start] demo http port=...`로 출력된다.
- 자동탐색된 ws 포트는 `VITE_DEMO_WS_URL` 환경변수로 vite에 주입되고, 브라우저는 이 값으로 mock 서버에 접속한다(수동 설정 불필요).
- 콘솔에 `VITE ... ready`와 `[Local: http://127.0.0.1:<port>/]`가 보이면 그 주소를 브라우저로 연다.
- 종료는 `Ctrl+C` — 두 프로세스가 함께 내려간다.

## 화면 구성

- 상단 툴바: **시나리오 프리셋** 3개(`정상 전송` / `부분 유실 → NACK 복구` / `전량 유실 → 실패`), 검증 경로(모드 A: Peer in-memory / 모드 B: 실-WebSocket) 선택, `reliable` 체크박스(모드 B에서만 활성 — JSONTransport의 exactly-once 전송 모드 opt-in, reliable-chunk-transport 01-spec), 후 `+ 패널 추가`. `reliable` 체크 상태는 패널 생성 시점에 고정된다(연결 중 토글 불가 — mode 선택과 동일한 관례). 체크 시 mock 서버에도 `unicast: true`로 연결해 자기 에코를 끈다(다른 연결로의 중계는 그대로).
- 시나리오 프리셋은 **원클릭 재현**이다: 기존 패널을 정리하고 reliable 발신(A)·수신(B) 패널 쌍을 새로 띄운 뒤, 대용량 payload를 A에서 전송한다. 수신측은 빠르게 NACK을 내보내고 발신측의 블라인드 재전송은 느리게 설정해, **부분 유실 복구가 블라인드 재전송이 아니라 NACK 선택 재전송으로 일어나는 것**이 타임라인에 드러나게 한다.
- 툴바 아래 **집계 칩**: 전체 타임라인 기준 `sent`/`acked`/`resent`/`failed` 건수를 한눈에 보여준다.
- 좌측: 연결(패널) 목록. 패널마다 상태 배지(connecting/open/closing/closed), reliable 패널이면 `reliable` 배지, 모드 B의 경우 서버가 발급한 `remoteConnectionId`, **전송 단위 카드**(아래 참고), 조건 슬라이더/입력(latencyMs·jitterMs·unordered·maxPacketBytes·dropRate·corruptRate·`드랍 대상` — 모드 A는 dropRate/corruptRate/드랍대상 비활성), 모드 B에서는 `다음 N개 강제 드랍` 버튼, payload JSON 입력창과 대용량 생성 버튼, `Send`/`Post`/`Ping`(모드 B는 Ping 비활성)/`Close`/`Reconnect` 버튼, `pending` 카운트를 보여준다.
- **전송 단위 카드**: 하나의 `send`(tid 단위)를 카드로 묶어 라이프사이클 칩(`전송중` → `재전송 N` / `NACK 복구중` → `✅ acked`·`assembled` / `❌ failed`)과 청크 그리드를 보여준다. 그리드 셀은 타임라인 이벤트에서 파생되며 상태별로 색칠된다 — 도착·확인=초록, 미확인=회색-파랑, 유실=빨강, 재전송 중=주황, 미관측=회색. 드랍됐다가 재전송돼 결국 도착한 셀은 초록 위에 **주황 링**으로 복구 흔적을 남긴다. 카드는 이 패널의 역할(`발신 →` / `수신 ←`)을 라벨로 표기하고, 실패 시 테두리가 빨강으로 바뀐다. drop/nack이 있었으면 `drop N · nack N · chunks N` 요약을 덧붙인다.
- **드랍 대상**(모드 B): dropRate·강제 드랍이 어느 프레임에 적용될지 고른다 — `전체`(모든 아웃바운드) / `인입 청크 (json:chunk)`(발신측 데이터 청크만 — 이걸 드랍해야 수신측이 결측을 감지해 NACK을 낸다) / `반환 ACK (json:ack/nack)`(수신측이 돌려보내는 ACK/NACK만). `다음 N개 강제 드랍`은 대상에 맞는 다음 N개 프레임을 **확정적으로**(확률 아님) 드랍해, 부분 유실을 정확히 N개로 재현한다.
- 모드 B 패널에는 별도 토글 없이 **Sockets 섹션**이 항상 표시된다. 메인 소켓(`S0`, 기존 스택)이 고정 행으로 시작하고, `+ Add Socket`(URL 입력, 기본값은 메인과 동일)으로 백업 소켓(`S1`, `S2`, …)을 원하는 만큼 추가할 수 있다 — `src/socket/multi.ts`(`createMultiSocketNetwork`)는 N개 소켓을 지원하며, 이 데모는 그 N개 구성을 그대로 시연한다. 각 소켓 행은 인덱스 칩(`Sk`)·URL·상태 배지·**Send**(그 소켓 단독 전송)·**Close** 버튼으로 구성되고, 백업 행에는 **Remove**(닫고 구성에서 제거) 버튼이 추가로 있다. 백업이 1개 이상이면 액션 버튼 영역의 **Send All**(`sendAll`로 구성된 모든 소켓에 동시 전송)이 활성화된다.
- 소켓을 추가/제거할 때마다 내부적으로 `createMultiSocketNetwork([S0, ...백업들])`을 **재생성**한다(01-spec Out of Scope — 런타임 추가/제거 없음, 구성을 바꾸려면 재생성하는 공식 패턴의 시연). 소켓 추가는 핸드셰이크를 기다리는 비동기 동작이라, 대기(pending) 중에는 URL 입력·`+ Add Socket`·`Close`/`Reconnect` 버튼이 비활성화된다 — 대기 중 수명주기 조작과 경합해 죽은/교체된 구성에 소켓이 잘못 묶이는 것을 막는다(내부적으로는 세대(generation) 가드로 이중 방어한다).
- 소켓 행의 **Send**는 그 소켓 인스턴스에 직접 `send(mid 프레임)`을 호출한다(S0도 포함 — transport·조건 슬라이더를 거치지 않는 raw 전송). 기존 액션 영역의 `Send`는 여전히 transport 경유(청킹·조건 슬라이더 적용, S0 단독)로 그대로 동작한다.
- 우측: 모든 패널이 공유하는 타임라인. 최신 이벤트가 위로 오며 시각·연결 배지(연결별 고정 색)·방향(`in`←/`out`→/`sys`·)·종류·상세를 표시한다. 계약 위반(`severity: 'error'`)은 배경색으로 구분되고, `chunk-out`/`drop`/`corrupt`/`expired`/`duplicate`/`ack`/`nack`/`resend`/`reliable-fail`은 별도 색으로 강조된다. Sockets 섹션과 관련된 모든 이벤트(소켓 행 send·Send All·receive·duplicate·에러·close)는 상세 앞에 `Sk` 칩이 붙어 어느 소켓을 오갔는지 한눈에 보여준다(transport 경로 이벤트는 무칩 유지). 목록 상단의 체크박스로 자동 스크롤 고정을 끄고 켤 수 있다.

## 검증 시나리오

각 행의 절차를 그대로 따라 하면 기대 이벤트 시퀀스가 타임라인에 나타나야 한다. 나타나지 않으면 `src/socket`에 회귀가 있다는 신호다.

| 검증 대상 | 조작 절차 | 기대 타임라인 이벤트 시퀀스 | 실패로 판정할 신호 |
|---|---|---|---|
| 기본 왕복 (send→result · ping→pong) | 모드 A로 패널 추가 → 상태가 `open`이 될 때까지 대기 → payload 입력 → `Send` 클릭 → `Ping` 클릭 | `open`(sys) → `send`(out) → `result`(in, 같은 mid) → `ping`(out) → `pong`(in, 같은 mid) | `send` 뒤에 `result`가 끝내 나타나지 않는다 / `ping` 뒤에 `pong`이 나타나지 않는다 / `result`·`pong`의 mid가 직전 `send`·`ping`과 다르다 |
| 대용량 청크 분할·재조립 | 모드 B로 패널 추가 → `open`+`handshake` 확인 → `대용량 생성` 클릭(현재 maxPacketBytes를 넘는 payload 자동 생성) → `Send` | `send`(out) → `chunk-out`(out) N회(index 0..total-1) → `receive`(in) N회(서버 에코) → `pending`(파생, 증가 후 재조립 완료 시 감소) → `assemble`(in) | `chunk-out`이 1건만 나오고 분할되지 않는다 / `assemble`이 끝내 나타나지 않고 패널의 `pending` 카운트가 0으로 내려가지 않는다 |
| 수명주기 (handshake·close·reconnect) | 모드 B로 패널 추가 → `open`+`handshake`(remoteConnectionId 확인) → `Close` 클릭(상태 `closed` 확인) → `Reconnect` 클릭 | `open`(sys) → `handshake`(in, connectionId) → `close`(sys, closed by client) → (재연결 스택 재생성) `handshake`(in, 새 connectionId) → `open`(sys) → `reconnect`(sys) | `Close` 후 상태 배지가 `closed`로 바뀌지 않는다 / `Reconnect` 후 새 `handshake`·`reconnect` 이벤트가 나타나지 않거나 `remoteConnectionId`가 갱신되지 않는다 |
| 악조건 강건성 (latency·jitter·unordered) | 패널에서 `latencyMs`(예: 500)·`jitterMs`(예: 300)를 올리고 `unordered` 체크 → `configure`(sys) 확인 → `Send`를 연속 여러 번 클릭 | `configure`(sys, 반영된 값) → `send`(out) 여러 건 → 지연되어 순서가 뒤섞여 도착해도 각 `result`/`receive`·`assemble`이 정확한 mid/tid로 상관된다 | 지연 중에도 mid/tid 상관이 어긋나 엉뚱한 `result`가 매칭된다 / 지연으로 이벤트 자체가 누락된다 / 순서섞임만으로 청크 재조립이 실패한다(있으면 회귀) |
| 결함 탐지 (drop→pending→expired · corrupt→json.chunk.hash) | **드랍**: 모드 B, `dropRate=1` → `대용량 생성` → `Send` → 수 초 대기(`partialTtlMs` 10s, `cleanupIntervalMs` 1s 주기 정리) / **변조**: `dropRate=0`, `corruptRate=1` → `대용량 생성` → `Send` | 드랍: `send`(out) → `chunk-out`(out) → `drop`(out, 일부) → `pending`(파생, 유지) → 약 10초 후 `expired`(sys, **severity=error**, scope `json.partial.expired`) / 변조: `send`(out) → `chunk-out`(out) → `corrupt`(out) → `receive`(in) → `error`(sys, **severity=error**, detail에 `json.chunk.hash` 포함) | `expired`/`error` 이벤트가 끝내 나타나지 않는다 / 나타나도 `severity`가 `error`로 시각 구분되지 않아 정상 흐름과 헷갈린다 |
| Sockets 섹션 — 소켓 추가(N=3 구성) | 모드 B로 패널 추가 → `open`+`handshake`(S0, 1건) 확인 → `+ Add Socket` 클릭 2회(URL은 기본값 그대로 두어도 됨) | `handshake`(in, S1) → `handshake`(in, S2) — 누적 3건 → Sockets 섹션에 S0/S1/S2 3행이 모두 `open` → 액션 영역의 `Send All` 활성화 | S1·S2 `handshake`가 나타나지 않거나 해당 행이 `open`이 되지 않는다 / 추가 중 S0 상태가 흔들린다(무영향이어야 함) / 2회 추가했는데 3행이 아니다 |
| Send All 전체 전송·중복 판별(N=3, N² 공식) | **패널이 화면에 하나만 있는 상태**(다른 패널이 붙어 있으면 mock 서버 전역 브로드캐스트로 건수가 달라진다)에서 위 N=3 구성으로 payload 입력 → `Send All` 클릭 | `send`(out, sendAll 표기) → `receive`(in) 정확히 1건 → `duplicate`(in, 강조색) 정확히 8건, 모두 같은 mid — 소켓 3개가 각각 독립 전송하고 서버가 매 프레임을 3개 연결 모두에 재중계하므로 총 N²=9건(에코 3 + 상호 중계 6) 도착, 소켓별로 3건씩 고르게 분포(각 이벤트의 `Sk` 칩으로 확인) | 총 수신 건수가 9건(N²)이 아니다(다른 패널이 같은 서버에 붙어 있는지 확인) / 특정 소켓의 칩이 하나도 안 보인다(그 소켓이 격리·누락됐다는 신호) |
| 소켓 단독 Send(N건 공식) | 위 N=3 구성에서 S1 행의 `Send` 클릭 | S1 행의 `send`(out, `S1` 칩) → `receive`(in) 1건 + `duplicate`(in) 2건, 총 N=3건(에코 1 + 중계 2), 모두 같은 mid | 수신 건수가 3건이 아니다 / 발신 이벤트에 `S1` 칩이 없어 어느 소켓에서 나갔는지 알 수 없다 |
| 소켓 격리 — Remove Socket 후 재구성 | 위 N=3 구성에서 S1 행의 `Remove` 클릭(S2가 S1로 재번호되어 2행만 남음 확인) → `Send All` 재클릭 | `close`(sys, S1 removed by client) → Sockets 섹션이 2행(S0·재번호된 S1)으로 축소 → 재클릭한 `Send All`의 수신 건수는 N²=4건(2개 구성 기준)으로 줄어듦 → **제거 후 남은 소켓(구 S2)은 행 라벨·타임라인 칩·`sendAll` 실패 태그 전부 새 번호(S1)로 일치 표기된다**(구 번호 S2가 어디에도 남지 않음) | Remove 후에도 이전 소켓이 목록에 남아 있다 / 재클릭한 `Send All`의 수신 건수가 여전히 9건이다(합성체가 재생성되지 않았다는 신호) / 남은 소켓의 행 라벨은 S1인데 수신·close 이벤트의 칩은 여전히 S2로 나온다(직접 구독 태깅이 재구독되지 않았다는 신호) |
| 소켓 격리 — 백업 Close(제거 아님) 후 무영향 | N=2 구성에서 백업 행(S1)의 `Close` 클릭(구성에는 남고 상태만 `closed`) → 기존 `Send`(액션 영역) 클릭 | `close`(sys, S1 closed by client, S1 행 상태 `closed`) → 기존 `Send`는 `chunk-out`/`receive`/`assemble`로 평소와 동일하게 정상 동작 | 백업 `Close` 후 기존 `Send`(transport 경유)가 영향을 받는다(격리 위반) / S1 행이 `closed`인데도 여전히 `open`으로 보인다 |
| 소켓 격리 — S0 Close 후 "정직한" 실패 대비 | N=2 구성에서 S0 행의 `Close` 클릭 → 기존 `Send`(액션 영역) 클릭 → `Send All` 클릭 | `close`(sys, S0 closed by client) → 기존 `Send`는 `error`(sys, **severity=error**, scope `json.send` — transport도 S0 단독이라 함께 죽는다) → `Send All`은 `error`(sys, **severity=error**, detail에 `network.multi.send`·`S0` 칩 포함) → 살아있는 백업으로는 `receive`(in) 1건 지속(연결이 하나뿐이면 duplicate 없음) | S0 `Close` 후에도 기존 `Send`가 성공한다(정직한 표시 위반 — S0가 죽었으면 S0 전용 경로도 죽어야 한다) / `Send All` 실패가 에러 이벤트로 나타나지 않는다 / 에러 이벤트에 소켓 칩이 없어 어느 쪽이 죽었는지 알 수 없다 / 살아있는 백업으로의 전송까지 함께 중단된다 |
| Sockets 섹션 — 동시성 방어(pending 중 수명주기 조작 차단) | 모드 B로 패널 추가 → `open` 확인 → `+ Add Socket` 클릭 직후(핸드셰이크 대기 중, 아주 짧은 창) URL 입력·`+ Add Socket`·`Close`/`Reconnect` 버튼 상태를 관찰 | 클릭 직후 짧게 해당 버튼들이 비활성화됐다가, 추가가 끝나면(새 소켓 `handshake` 도착) 다시 활성화된다 | 대기 중에도 버튼들이 계속 클릭 가능하다(경합 시 고아 소켓·상태 불일치로 이어질 수 있는 회귀 신호) |
| 신뢰 모드(reliable) — 정상 왕복 (프리셋 `정상 전송`) | 툴바 `정상 전송` 클릭(발신 A·수신 B 쌍 자동 생성) | A: `send`(out) → `chunk-out`(out) N회 → B: `receive`(in) N회 → `assemble`(in) → A: `ack`(in) → A 카드 `✅ acked`(초록 그리드), B 카드 `✅ assembled`. A에게 자기 `receive`가 없어야 함(자기 에코 부재) | A 자신에게도 `receive`/`assemble`이 뜬다(자기 에코 회귀) / `ack`가 A에 도착하지 않아 카드가 `acked`로 끝나지 않는다 |
| 신뢰 모드 — 부분 유실 → NACK 선택 재전송 복구 (프리셋 `부분 유실 → NACK 복구`) | 툴바 `부분 유실 → NACK 복구` 클릭(발신 A의 `드랍 대상`=인입 청크 + `다음 2개 강제 드랍`이 자동 설정된 뒤 대용량 전송). 수동 재현 시: reliable A/B 쌍에서 A의 `드랍 대상`을 `인입 청크`로 두고 `다음 N개 강제 드랍` → `대용량 생성` → `Send` | A: `chunk-out`(out) N회 → `drop`(out) 2회(`dropped chunk i/N`) → B가 결측 감지 → `nack`(in, A쪽, `chunks` 결측 목록) → A: `chunk-out`(out) 재전송(결측 인덱스만) → B: `assemble` → A: `ack`. 카드는 복구된 셀(0·1)에 **주황 링**을 남긴 초록 그리드로 `✅ acked` | `drop`이 ACK(64B)만 잡고 청크가 안 빠져 `nack`이 안 뜬다(**드랍 대상이 `인입 청크`인지 확인** — 이게 이번 개정의 핵심) / `nack` 없이 블라인드 재전송으로만 복구된다 |
| 신뢰 모드 — 전량 유실 → 복구 불능 실패 (프리셋 `전량 유실 → 실패`) | 툴바 `전량 유실 → 실패` 클릭(발신 A의 `드랍 대상`=인입 청크 + `dropRate=1`, `maxAttempts`를 낮춰 빠른 실패로 설정한 뒤 대용량 전송) | A: `chunk-out`(out) → `drop`(out) 전량(청크만) → B가 계속 결측 → `nack`(in) 반복 → A: `resend`(out, attempt 증가)도 계속 드랍 → `maxAttempts` 소진 → `reliable-fail`(sys, **severity=error**, scope `json.reliable.failed`) + B에 `json:error` 통지 → A의 `Send`가 reject. 카드는 전 셀 빨강 + 빨강 테두리로 `❌ failed` | `reliable-fail`이 끝내 안 뜨고 조용히 멈춘다 / 복구 불능인데도 카드가 `acked`로 끝난다(잘못된 조립) |

## 테스트

```sh
cd demo/socket-verifier
npx vitest run
```

38개 테스트(mock 서버·조건 데코레이터·상태 스토어·모드 A/B 세션·Sockets 섹션 확장·addSocket 레이스 회귀)가 모두 통과해야 한다. 이 테스트는 자동화된 회귀 가드이며, 위 시나리오 표의 브라우저 육안 검증을 대체하지 않는다.

## 제약 (Out of Scope)

- Sockets 섹션은 `src/socket/multi.ts`(`createMultiSocketNetwork`)의 raw 전체 전송 계약을 그대로 시연한다 — 라이브러리·데모 모두 N개 소켓을 지원한다. `Send All`·소켓 행 `Send`가 보내는 mid 프레임은 transport(JSONTransport)·조건 데코레이터를 거치지 않으므로 청킹·조건(latency/jitter/drop/corrupt)이 적용되지 않는다. 기존 액션 영역의 `Send`(transport 경유)는 백업 소켓 구성과 무관하게 항상 조건이 적용된다.
- 실서버(WSS API) 연동 검증 — 로컬 mock 서버로만 검증한다.
- CI·vitest 같은 자동화 테스트를 대체하지 않는다 — 이 도구는 육안 확인용 보조 수단이다.
- 패킷 유실·변조로부터의 복구(재전송·ACK)는 `reliable` 체크 시에만 다룬다(NACK 선택 복구·블라인드 폴백·`maxAttempts` 소진 후 실패 통지) — 체크하지 않으면 여전히 결함이 타임라인에 드러나는 것까지만 검증한다.
- 확률적 조건(`dropRate`/`corruptRate`/`jitterMs`)의 시드 고정 이벤트 시퀀스 재현은 지원하지 않는다 — 같은 조건값을 다시 입력해 같은 설정을 재현하는 것까지만 보장한다.
- 시나리오 저장·재생 기능은 없다 — 위 표의 절차를 매번 손으로 재현한다.
- 바이너리 프레임 검증은 다루지 않는다 — 서버·클라이언트 모두 조용히 무시한다.
