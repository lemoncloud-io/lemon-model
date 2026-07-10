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

- 상단 툴바: 검증 경로(모드 A: Peer in-memory / 모드 B: 실-WebSocket) 선택 후 `+ 패널 추가`.
- 좌측: 연결(패널) 목록. 패널마다 상태 배지(connecting/open/closing/closed), 모드 B의 경우 서버가 발급한 `remoteConnectionId`, 조건 슬라이더/입력(latencyMs·jitterMs·unordered·maxPacketBytes·dropRate·corruptRate — 모드 A는 dropRate/corruptRate 비활성), payload JSON 입력창과 대용량 생성 버튼, `Send`/`Post`/`Ping`(모드 B는 Ping 비활성)/`Close`/`Reconnect` 버튼, `pending` 카운트를 보여준다.
- 우측: 모든 패널이 공유하는 타임라인. 최신 이벤트가 위로 오며 시각·연결 배지(연결별 고정 색)·방향(`in`←/`out`→/`sys`·)·종류·상세를 표시한다. 계약 위반(`severity: 'error'`)은 배경색으로 구분되고, `chunk-out`/`drop`/`corrupt`/`expired`는 별도 색으로 강조된다. 목록 상단의 체크박스로 자동 스크롤 고정을 끄고 켤 수 있다.

## 검증 시나리오

각 행의 절차를 그대로 따라 하면 기대 이벤트 시퀀스가 타임라인에 나타나야 한다. 나타나지 않으면 `src/socket`에 회귀가 있다는 신호다.

| 검증 대상 | 조작 절차 | 기대 타임라인 이벤트 시퀀스 | 실패로 판정할 신호 |
|---|---|---|---|
| 기본 왕복 (send→result · ping→pong) | 모드 A로 패널 추가 → 상태가 `open`이 될 때까지 대기 → payload 입력 → `Send` 클릭 → `Ping` 클릭 | `open`(sys) → `send`(out) → `result`(in, 같은 mid) → `ping`(out) → `pong`(in, 같은 mid) | `send` 뒤에 `result`가 끝내 나타나지 않는다 / `ping` 뒤에 `pong`이 나타나지 않는다 / `result`·`pong`의 mid가 직전 `send`·`ping`과 다르다 |
| 대용량 청크 분할·재조립 | 모드 B로 패널 추가 → `open`+`handshake` 확인 → `대용량 생성` 클릭(현재 maxPacketBytes를 넘는 payload 자동 생성) → `Send` | `send`(out) → `chunk-out`(out) N회(index 0..total-1) → `receive`(in) N회(서버 에코) → `pending`(파생, 증가 후 재조립 완료 시 감소) → `assemble`(in) | `chunk-out`이 1건만 나오고 분할되지 않는다 / `assemble`이 끝내 나타나지 않고 패널의 `pending` 카운트가 0으로 내려가지 않는다 |
| 수명주기 (handshake·close·reconnect) | 모드 B로 패널 추가 → `open`+`handshake`(remoteConnectionId 확인) → `Close` 클릭(상태 `closed` 확인) → `Reconnect` 클릭 | `open`(sys) → `handshake`(in, connectionId) → `close`(sys, closed by client) → (재연결 스택 재생성) `handshake`(in, 새 connectionId) → `open`(sys) → `reconnect`(sys) | `Close` 후 상태 배지가 `closed`로 바뀌지 않는다 / `Reconnect` 후 새 `handshake`·`reconnect` 이벤트가 나타나지 않거나 `remoteConnectionId`가 갱신되지 않는다 |
| 악조건 강건성 (latency·jitter·unordered) | 패널에서 `latencyMs`(예: 500)·`jitterMs`(예: 300)를 올리고 `unordered` 체크 → `configure`(sys) 확인 → `Send`를 연속 여러 번 클릭 | `configure`(sys, 반영된 값) → `send`(out) 여러 건 → 지연되어 순서가 뒤섞여 도착해도 각 `result`/`receive`·`assemble`이 정확한 mid/tid로 상관된다 | 지연 중에도 mid/tid 상관이 어긋나 엉뚱한 `result`가 매칭된다 / 지연으로 이벤트 자체가 누락된다 / 순서섞임만으로 청크 재조립이 실패한다(있으면 회귀) |
| 결함 탐지 (drop→pending→expired · corrupt→json.chunk.hash) | **드랍**: 모드 B, `dropRate=1` → `대용량 생성` → `Send` → 수 초 대기(`partialTtlMs` 10s, `cleanupIntervalMs` 1s 주기 정리) / **변조**: `dropRate=0`, `corruptRate=1` → `대용량 생성` → `Send` | 드랍: `send`(out) → `chunk-out`(out) → `drop`(out, 일부) → `pending`(파생, 유지) → 약 10초 후 `expired`(sys, **severity=error**, scope `json.partial.expired`) / 변조: `send`(out) → `chunk-out`(out) → `corrupt`(out) → `receive`(in) → `error`(sys, **severity=error**, detail에 `json.chunk.hash` 포함) | `expired`/`error` 이벤트가 끝내 나타나지 않는다 / 나타나도 `severity`가 `error`로 시각 구분되지 않아 정상 흐름과 헷갈린다 |

## 테스트

```sh
cd demo/socket-verifier
npx vitest run
```

28개 테스트(mock 서버·조건 데코레이터·상태 스토어·모드 A/B 세션)가 모두 통과해야 한다. 이 테스트는 자동화된 회귀 가드이며, 위 시나리오 표의 브라우저 육안 검증을 대체하지 않는다.

## 제약 (Out of Scope)

- 클라이언트당 다중 연결(듀얼소켓) 검증 — 다음 버전. 단일소켓 클라이언트를 여러 패널로 동시에 추가해 검증하는 것은 범위 안이다.
- 실서버(WSS API) 연동 검증 — 로컬 mock 서버로만 검증한다.
- CI·vitest 같은 자동화 테스트를 대체하지 않는다 — 이 도구는 육안 확인용 보조 수단이다.
- 패킷 유실·변조로부터의 복구(재전송·ACK)는 다루지 않는다 — 결함이 타임라인에 드러나는 것까지만 검증한다.
- 확률적 조건(`dropRate`/`corruptRate`/`jitterMs`)의 시드 고정 이벤트 시퀀스 재현은 지원하지 않는다 — 같은 조건값을 다시 입력해 같은 설정을 재현하는 것까지만 보장한다.
- 시나리오 저장·재생 기능은 없다 — 위 표의 절차를 매번 손으로 재현한다.
- 바이너리 프레임 검증은 다루지 않는다 — 서버·클라이언트 모두 조용히 무시한다.
