# Model Sync Client 사용 가이드

문서 순서: [00-requirement](./00-requirement.md) → [01-design](./01-design.md) → [02-plan](./02-plan.md) → `03-client-guide.md`

## 전체 그림

서비스가 준비할 것은 세 가지.

1. `CoreModel`을 상속한 도메인 모델 타입 (예: `UserModel`)
2. 서버 wire 규약을 아는 프로토콜 어댑터 (`buildPull` / `parseReply` / `parseEvent`)
3. tick 호출 주기 (setInterval, visibility 이벤트, 사용자 액션)

lemon-model이 제공하는 것: 웹소켓 network 어댑터, L3 socket client(요청-응답 추적·라우팅), L4 sync machine(스토어, 동기화 대상 판정).

```ts
import {
    createOwnedWebSocketNetwork,
    createSocketClient,
    createSyncMachine,
    CoreModel,
    SyncProtocolAdapter,
} from 'lemon-model';
```

## 0. 서버가 지켜야 할 최소 계약

wire의 나머지는 전부 자유지만(type 작명, data 내부 구조), 이 세 가지만은 표준이다.

1. 봉투는 JSON `{ type: string, data, mid }` — 클라이언트가 요청을 이 모양으로 보낸다.
2. 응답은 `type: 'result'` 또는 `'error'` + 요청과 같은 `mid` — 요청-응답 매칭을 L3가 하기 때문.
3. 동기화 모델에는 `id`와 `updatedAt`(모델별 단조 증가)을 싣는다. 삭제는 `deletedAt`으로 — 이벤트뿐 아니라 **pull 응답(변경 피드)에도 soft-delete된 모델을 포함**해야 삭제가 전파된다.

이 계약을 못 지키는 레거시 서버(chatic의 `:ok`/`:error` suffix, top-level `domain` 필드 등)는 어댑터가 아니라 network 단 translator decorator로 번역해 붙인다 — [04-roadmap](./04-roadmap.md) 참고.

## 1. 도메인 모델 정의

```ts
interface UserModel extends CoreModel<'user'> {
    name?: string;
    email?: string;
}
```

서버는 모델마다 `id`와 `updatedAt`(ms epoch)을 반드시 실어야 하고, 같은 모델의 연속 변경에서 `updatedAt`이 단조 증가해야 한다. 삭제는 `deletedAt`이 찍힌 모델로 내려보낸다. `updatedAt`이 없는 모델은 반영되지 않는다.

## 2. 어댑터 구현

머신은 서버 규약을 모르므로, 서비스가 세 가지 변환을 주입한다.

```ts
const userAdapter: SyncProtocolAdapter<UserModel> = {
    /** 워터마크(since)와 커서로 pull 요청 봉투를 만든다 */
    buildPull: (since, cursor) => ({ type: 'sync/user:pull', data: { since, cursor } }),
    /** pull 응답에서 모델 배열과 다음 페이지 커서를 꺼낸다. next가 없으면 pull 종료 */
    parseReply: data => ({ models: data?.models ?? [], next: data?.next }),
    /** 서버 발신 이벤트가 이 타입 것인지 판정하고 모델을 꺼낸다. 아니면 undefined */
    parseEvent: message => (message.type === 'sync/user:updated' ? (message.data as UserModel[]) : undefined),
};
```

- `parseEvent`는 순수 함수여야 한다(부수효과 금지). 이벤트는 등록된 모든 타입의 `parseEvent`에 fan-out되므로, 자기 타입이 아니면 반드시 `undefined`를 반환한다.
- 변경분이 많은 서버는 pull 응답을 페이지로 나누고 `next` 커서를 실어주면 된다. 머신이 `next`가 없어질 때까지 루프를 돈다.

### 도메인별 파라미터와 스코프

pull 요청의 모양은 도메인마다 다르다. 도메인 파라미터는 어댑터를 만드는 클로저에 캡처한다 — 머신이 넣어주는 값은 `since`(워터마크)와 `cursor` 둘뿐이다.

```ts
const createUserAdapter = (scope: { gid: string }): SyncProtocolAdapter<UserModel> => ({
    buildPull: (since, cursor) => ({ type: 'sync/user:pull', data: { ...scope, since, cursor } }),
    ...
});
```

스코프(방·그룹 등)별로 따로 동기화하려면 그만큼 등록하면 된다. `register`의 type은 레지스트리 키일 뿐이라 자유롭게 지을 수 있고, 스토어·워터마크가 키별로 분리된다.

```ts
const room42 = machine.register('user:room-42', { adapter: createUserAdapter({ gid: 'room-42' }) });
```

### CoreModel이 아닌 대상

머신이 요구하는 것은 `SyncTarget`(`id`·`updatedAt`·`deletedAt`)뿐이라, 이 셋만 갖추면 CoreModel 밖 모델도 등록할 수 있다(예: GenAI 작업 진행 상태 — `id=streamId, updatedAt, progress`). 단 `GenAIStreamChunkEvent` 같은 **순서 스트림은 대상이 아니다** — 스토어는 id별 최신본만 남기므로, 청크 스트림은 `src/buffer`로 처리하고 거기서 파생한 상태 모델만 동기화에 올린다.

## 3. 배선

```ts
// L0/L1 — 웹소켓 network (소켓 수명은 이 레이어 소유)
const network = createOwnedWebSocketNetwork({ url: 'wss://api.example.io/ws?token=...' });

// L3 — socket client. 같은 소켓을 다른 모듈과 나눠 쓸 때는 filter로 자기 트래픽만 받는다
const client = createSocketClient(network, {
    filter: raw => {
        try {
            const type = JSON.parse(raw)?.type;
            //! 주의: 네임스페이스 prefix만 통과시키면 안 된다. 응답 봉투의 type은
            //! 'result'/'error'라서 이 둘을 빼면 모든 request가 timeout된다.
            return typeof type === 'string' && (type.startsWith('sync/') || type === 'result' || type === 'error');
        } catch {
            return false;
        }
    },
});

// L4 — sync machine + 타입 등록 (register 직후 초기 pull이 자동 수행된다)
const machine = createSyncMachine(client);
const users = machine.register('user', { adapter: userAdapter });
```

소켓을 혼자 쓰는 단순한 앱이면 `filter`를 생략해도 된다 — envelope으로 parse되지 않는 raw는 조용히 무시된다.

## 4. tick — 주기는 서비스가 정한다

머신에는 timer가 없다. 원하는 방식으로 `tick()`을 호출한다.

```ts
// 예: 30초 폴링 + 탭 복귀 시 즉시 동기화
const interval = setInterval(() => machine.tick(), 30_000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') machine.tick();
});
```

- `tick()`은 등록된 모든 타입을 pull 1회씩 돌린다. 이미 진행 중인 타입은 중첩 실행 없이 그 pull에 합류한다.
- pull은 워터마크(반영된 최대 `updatedAt`) 이후 변경분만 가져오므로 주기가 짧아도 낭비가 적다.
- 서버가 이벤트를 밀어주는 구조면 tick은 안전망 역할만 하므로 주기를 길게 잡아도 된다.

## 5. 읽기와 변경 구독

```ts
// 스냅샷 조회
const user = users.get('u123');
const all = users.list();

// 변경 구독 (cause: 'pull' | 'event')
const unsubscribe = users.onChange(({ cause, models }) => {
    render(users.list()); // models에는 이번에 반영·제거된 것만 담긴다
});

// 수동 pull (초기 로딩 실패를 직접 관찰하고 싶을 때)
const applied = await users.pull(); // 실패 시 reject, 스토어·워터마크는 그대로
```

`initialPull: false`로 등록하면 자동 초기 pull을 끄고 직접 `pull()`을 호출해 실패를 다룰 수 있다.

## 6. 정리(teardown)

```ts
users.close();     // 타입 1개 해제
machine.close();   // 전체 해제 (이벤트 구독 해제 포함)
client.close();    // pending 전부 reject + listener detach — 소켓은 닫지 않는다
network.close();   // 실제 웹소켓 close는 network 소유자의 몫
```

`client.close()`가 소켓을 닫지 않는 것은 의도된 설계다 — 한 소켓을 여러 모듈이 공유하므로, 소켓 수명은 network를 만든 쪽이 관리한다.

## 7. 테스트 — 서버 없이 Peer로

spec에서는 `src/sync/testing.ts`의 브리지로 in-memory `Peer`를 서버 대역으로 쓴다.

```ts
import { createPeerBridge } from '../sync/testing'; // 저장소 내부 상대 경로 (번들 미포함)

const bridge = createPeerBridge();
bridge.server.onMessage(message => {
    if (message.type === 'sync/user:pull') return { models: [...], next: undefined }; // 반환값이 자동 result 응답
    // 오류 응답은 명시적으로 만든다
    bridge.server.post({ type: 'error', data: { message: 'fail' }, mid: message.mid }, { clientId: bridge.clientId });
    throw new Error('replied manually'); // 자동 result가 겹치지 않게 throw로 끝낸다
});
const client = createSocketClient(bridge.network);
```

주의 두 가지: ① "무응답 서버"를 흉내낼 때 핸들러를 `return;`으로 끝내면 자동 빈 `result`가 나간다 — 반드시 `throw`로 끝낸다. ② in-memory 전달은 기본이 순서 미보장이므로 도착 순서가 아니라 수렴 결과를 assert한다.

## 제약과 앞으로

- **읽기 전용**: 로컬 변경을 서버로 보내는 push는 없다. 쓰기가 필요하면 일반 API(HTTP 등)로 쓰고, 결과는 이벤트/pull로 돌아와 반영된다.
- **재연결 없음**: 끊김 감지·재연결은 1차 범위 밖이다. 재연결 후에는 `machine.tick()` 한 번으로 워터마크 이후 변경분이 따라잡힌다.
- **오프라인 저장 없음**: 스토어는 메모리 전용이다. 새로고침하면 초기 pull부터 다시 시작한다.
- **패킷 제한**: 발신 봉투는 network의 `maxPacketBytes`(시뮬레이터 기본 64kb) 안에 들어야 한다. 초과 시 `request()`가 reject된다.
