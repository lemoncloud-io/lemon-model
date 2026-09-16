# Upload

클라이언트-서버 업로드 인터페이스 계약입니다. 클라이언트는 항상 `start` → 전송 → `complete` 순서로 돌고,
서버가 바이트를 inline(base64)으로 받을지 presigned PUT으로 받을지는 `transfer` 변형만 바뀔 뿐 호출 순서는
그대로입니다.

## 규칙

1. `start` 응답 `list`는 요청 `list`와 길이·순서가 같다. 슬롯별 검증 실패는 `status: 'failed'` + `error`로 오고, HTTP 4xx가 아니다.
2. `transfer`가 없는 슬롯은 보낼 바이트가 없다 — 이미 `stored`(dedup)이거나 `failed`다.
3. `transfer`는 실행기가 한 번 소비하고 버린다. 저장·로그·에러 메시지에 넣지 않는다.
4. 클라이언트는 id가 있는 모든 슬롯을 `complete`에 넣는다(실패한 슬롯은 `failure`와 함께). `complete`는 멱등이다.
5. `status: 'stored'`인 응답에는 `url`이 반드시 있다. 그 외 상태의 `url`은 정의되지 않는다.
6. `transfers`가 없으면 `['inline']`이다. 서버는 목록에서 그 파일 크기에 자기가 지원하는 첫 방식을 고르고, 없으면 그 슬롯을 `406 NOT ACCEPTABLE`로 실패시킨다.
7. `UploadBody.id`를 넣은 `start`는 아직 `pending`인 업로드의 transfer 재발급이다(만료 대응).
8. `hash`는 sha256 hex(64)다. 있으면 서버는 검증하고 불일치를 `400 INVALID`로 거절한다. 없어도 받는다.

## HTTP 바인딩

| 연산 | 메서드 · 경로 (`{base}` 상대) | lemon-core 매핑 |
| --- | --- | --- |
| start | `POST {base}/start` | `doPost(id='start')` — `/medias/upload`와 같은 verb-in-id |
| send | `POST {base}/{id}/send` | `doPost(id, cmd='send')` — `/upload/{id}/{cmd}` 라우트 모양과 동일 |
| complete | `POST {base}/complete` | `doPost(id='complete')` |
| read | `GET {base}/{id}` | `doGet(id)` |

### 전제조건

- 인가: 4연산 모두 호출자의 일반 API 인가. presigned URL만 무인가 hop.
- 2차: 버킷 CORS `AllowedMethod PUT` + 앱 origin + preflight OPTIONS 허용. 3차: `ExposeHeaders: ETag`까지.
- `url`은 안정적이어야 한다 — `upload$$` 스냅샷이 메시지에 박힌다.
- 서버는 `pending` 티켓을 TTL로 정리한다(구현).

## 버전 · 호환 규칙

- 계약 변경은 **추가만**: 필드는 옵션으로 추가, LUT 값 추가, `UploadTransfer` 변형 추가(협상이 보호), 연산 추가. 제거는 `@deprecated` 한 버전 뒤(조직 전환형 `new ?? old`).
- 절대 하지 않는 것: 옵션 → 필수 승격(`hash` 포함), `UploadView`/`UploadHead` 필드 제거, `status` 값의 의미 변경, `UploadInlineTransfer` 발급 중단.
