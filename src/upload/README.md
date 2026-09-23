# Upload

클라이언트-서버 업로드 인터페이스 계약입니다. 클라이언트는 항상 `start` → 전송 → `complete` 순서로 돌고,
서버가 바이트를 inline(base64)으로 받을지 presigned PUT으로 받을지는 `transfer` 변형만 바뀔 뿐 호출 순서는
그대로입니다.

## 규칙

1. `start` 응답 `list`는 요청 `list`와 길이·순서가 같다. 슬롯별 검증 실패는 `status: 'failed'` + `error`로 오고, HTTP 4xx가 아니다.
2. `transfer`도 `thumbnailTransfer`도 없는 슬롯만 보낼 바이트가 없다 — 이미 `stored`(dedup)이거나 `failed`다.
3. `transfer`와 `thumbnailTransfer`는 실행기가 한 번 소비하고 버린다. 저장·로그·에러 메시지에 넣지 않는다.
4. 클라이언트는 id가 있는 모든 슬롯을 `complete`에 넣는다(실패한 슬롯은 `failure`와 함께). `complete`는 멱등이다.
5. `status: 'stored'`인 응답에는 `url`이 반드시 있다. 그 외 상태의 `url`은 정의되지 않는다.
6. `transfers`가 없으면 `['inline']`이다. 서버는 목록에서 그 파일 크기에 자기가 지원하는 첫 방식을 고르고, 없으면 그 슬롯을 `406 NOT ACCEPTABLE`로 실패시킨다.
7. `UploadIntent.id`를 넣은 `start`는 기존 업로드의 전송 재발급이다. `pending`이면 둘 다(만료 대응), `stored`면 `thumbnailTransfer`만 — 올라간 바이트는 바뀌지 않는다.
8. `hash`는 sha256 hex(64)다. 있으면 서버는 검증하고 불일치를 `400 INVALID`로 거절한다. 없어도 받는다.
9. `thumbnailTransfer`는 presigned PUT만이다. `send`는 업로드를 주소로 하지 페이로드를 주소로 하지 않아서, inline 지시는 원본 바이트를 덮어쓴다. 줄 방법이 없으면 서버는 그냥 안 준다.
10. 썸네일은 종속물이다. 전송이 실패해도 업로드는 실패하지 않는다 — 클라이언트는 `complete`에 싣지 않고, 서버가 저장소를 보고 정산한다.

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
- 응답의 `url`·`thumbnail.url`은 **오래 쓰는 주소가 아니다.** 서버가 읽을 때마다 새로 발급할 수 있고 만료된다. 받을 때마다 쓰고, 저장하지 않는다.
- 응답과 저장은 다르다. 다른 레코드에 업로드를 어떻게 담을지는 그 서버의 모델 몫이고, 이 계약은 정하지 않는다. 다만 담는다면 주소는 빼고 설명 필드만 담는다 — 주소는 저장하는 값이 아니다.
- 서버는 `pending` 티켓을 TTL로 정리한다(구현).

## 버전 · 호환 규칙

- 계약 변경은 **추가만**: 필드는 옵션으로 추가, LUT 값 추가, `UploadTransfer` 변형 추가(협상이 보호), 연산 추가. 제거는 `@deprecated` 한 버전 뒤(조직 전환형 `new ?? old`).
- **1.5.0이 이 원칙을 한 번 깬다.** 소비자가 붙기 전 마지막 정리라 한 번에 치렀고, 이후로는 다시 추가만이다.

  | 무엇 | 전 → 후 |
  | --- | --- |
  | 개명 | `UploadView`→`Upload` · `UploadBody`→`UploadIntent` · `UploadContentBody`→`UploadContent` · `UploadStoredView`→`UploadStored` |
  | 제거 | `UploadHead` · `UploadRef` · `UploadRefs` · `UploadThumbnail`(→ `UploadResource`가 흡수) |
  | 필드 제거 | `createdAt` · `updatedAt` · `deletedAt` · `$` — 계약이 모델 층을 상속하지 않게 됐다 |
  | 응답 필드 | `thumbnail$` → `thumbnail` |
  | 타입 교체 | `thumbnail`이 url 문자열에서 객체로 |

  바뀐 이유는 하나다 — 이건 와이어 규약이지 모델이 아니다. `Head`/`View`/`Body`/`$`는 서버가 자기
  모델 층에서 쓰는 어휘이고, 계약은 바이트의 서술(`UploadContent`)과 저장된 것의 주소(`UploadResource`)
  둘만 안다.
- 절대 하지 않는 것: 옵션 → 필수 승격(`hash` 포함), `Upload` 필드 제거, `status` 값의 의미 변경, `UploadInlineTransfer` 발급 중단.
