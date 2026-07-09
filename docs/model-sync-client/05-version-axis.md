# Version Axis (versionOf) Design

문서 순서: [01-design](./01-design.md) → [04-network-decorators](./04-network-decorators.md) → `05-version-axis.md`

## 개요

v1의 최신 판정은 `updatedAt` 고정이다. 이 문서는 판정 축을 주입식으로 일반화하는 `versionOf` 설계를 정의한다 — `seq`, `lock`/`next` 등 다른 단조값 기반 대상도 같은 머신으로 동기화하기 위함이다. (2026-07-06 논의 확정)

모든 변경은 additive다. 주입하지 않으면 기본값이 `updatedAt`을 읽으므로 기존 사용자·기존 spec은 무영향이다.

## 결정과 근거

### comparator가 아니라 versionOf인 이유

v1에서 `updatedAt`은 두 역할을 겸한다.

- **(a) 모델별 최신 판정** — `applyOne()`의 `incoming.updatedAt > local.updatedAt`
- **(b) 워터마크 축** — pull 반영분의 `max(updatedAt)`이 `buildPull(since)`의 since로 되돌아감

`comparator(incoming, local): boolean`은 (a)만 일반화한다. 스칼라가 나오지 않아 (b)의 since를 만들 수 없고, 별도 `watermarkOf` 주입이 추가로 필요해져 두 주입 간 축 불일치가 생길 수 있다. `versionOf(model): number`는 같은 스칼라 하나로 (a)와 (b)를 모두 커버한다. 서버 계약 전제(모델별 단조 증가 보장)가 이미 "단조 스칼라 하나"를 요구하므로, comparator의 추가 표현력(벡터 클록 등)은 전제상 쓸 곳이 없다.

### 어댑터에 주입하는 이유

`buildPull(since)`의 since 의미는 이미 `SyncProtocolAdapter`가 소유한다. versionOf가 정의하는 판정 축과 buildPull이 기대하는 since 축은 반드시 같아야 하므로, 두 계약을 같은 객체에 둔다. 둘 다 무표식 number라 축 일치를 타입이 강제하지는 못한다 — co-location은 불일치를 한 객체 안에서 눈에 띄게 만드는 관찰성 장치이고, 실제 정합 보장은 아래 서버 계약 전제의 몫이다. versionOf는 모델 하나에 대한 순수 함수이므로 "어댑터는 로컬 상태를 모른다"는 기존 원칙과 충돌하지 않는다.

## 계약 변경

`SyncProtocolAdapter`에 optional 멤버 하나를 추가한다.

```ts
export interface SyncProtocolAdapter<M extends SyncTarget> {
    /** 판정·워터마크 공용 버전 축. undefined 반환 시 해당 모델 무시. 생략 시 기본값 m => m.updatedAt.
     *  parseEvent와 같은 순수·total 요구 — throw 금지(머신의 이벤트 fan-out 루프는 무보호), 반환값은 양의 유한 수 또는 undefined */
    versionOf?: (model: M) => number | undefined;
    /** since(versionOf 축 워터마크)와 커서로 pull 요청 구성. since 생략은 전체 pull — 시그니처 불변, 주석의 since 정의만 갱신 */
    buildPull(since?: number, cursor?: any): { type: string; data: any };
    // parseReply / parseEvent 불변
}
```

- `SyncTarget` 계약은 변경하지 않는다. 세 필드가 전부 optional이라 `updatedAt` 없는 대상(seq만 있는 `ProgressState` — PR#9 미머지, 아래 비범위 참조)도 이미 구조적으로 만족한다. `updatedAt`의 의미만 "기본 versionOf가 읽는 필드"로 좁아진다.
- `deletedAt` 제거 규칙 자체는 versionOf와 직교하며 그대로 유지된다. 단 삭제 반영도 최신 판정을 통과해야 하므로 **tombstone도 축 값을 실어야 한다** — `versionOf(tombstone)`이 undefined면 삭제가 조용히 드롭되어 삭제분이 로컬에 영구 잔존한다(아래 서버 계약 전제 참조).
- 같은 type 재등록 시 옵션이 무시되는 기존 규칙(`register`)이 versionOf에도 적용된다 — 등록 후 versionOf 재지정은 불가하며, 축을 바꾸려면 close 후 재등록해야 한다.

## 의미론 변경

[01-design의 최신 판정 표](./01-design.md#동기화-의미론)에서 축 치환만 일어난다. 규칙 구조는 불변이다.

| v1 (updatedAt 고정) | 일반화 (versionOf 축) |
| --- | --- |
| `incoming.updatedAt > local.updatedAt`이면 반영 | `versionOf(incoming) > versionOf(local)`이면 반영 |
| 수신 모델에 updatedAt 없음 → 무시 | `versionOf(incoming)`이 undefined → 무시 |
| 로컬 모델에 updatedAt 없음 → stale 취급, 덮어씀 | `versionOf(local)`이 undefined → stale 취급, 덮어씀 |
| 워터마크 = pull 반영분 `max(updatedAt)`, 단조, pull만 전진 | 워터마크 = pull 반영분 `max(versionOf(m))`, 단조, pull만 전진 (**전진 규칙 불변**) |

- `buildPull(since)`의 since 정의: "updatedAt 워터마크" → "**versionOf 축의 워터마크**". 기본 versionOf에서는 v1과 완전 동일하다.
- 이벤트가 워터마크를 전진시키지 않는 안전망 규칙은 축과 무관하게 유지된다.

### 서버 계약 전제 (추가분)

versionOf를 주입하는 대상은 서버가 다음을 보장해야 한다. 모두 updatedAt 단조 보장과 같은 성격의 서버 계약이다.

1. **축 기준 delta 조회**: since가 versionOf 축의 값이므로, 예를 들어 `versionOf: m => m.seq`면 서버 pull은 "seq > since인 모델" 질의가 가능해야 한다.
2. **축 값은 양의 유한 수**: 머신의 워터마크는 `0` 초기값 + `since = watermark || undefined` sentinel을 쓰므로, 축에 0이나 음수가 존재하면 워터마크가 전진하지 못해 매 tick이 전체 pull로 퇴화한다(손상은 아니나 증분 무력화). updatedAt(epoch ms)·seq(1부터) 같은 통상 축은 자연 만족한다.
3. **tombstone도 축 값을 싣는다**: 삭제 이벤트/pull 응답의 tombstone에 축 필드가 없으면 최신 판정 이전에 무시되어 삭제가 로컬에 반영되지 않는다.

### lock/next 확장의 흡수

01-design 서버 계약 전제 문단의 "updatedAt 동치 한계 → `lock`/`next` 시퀀스 필드 판정으로 확장" 언급은 별도 메커니즘이 필요 없어진다. `versionOf: m => m.next`가 곧 그 확장이다.

### 기존 문서 영향

- 01-design — 서버 계약 전제 문단과 비범위 절의 comparator 항목을 이 문서 참조로 갱신했다(2026-07-06).
- 02-plan·03-client-guide — updatedAt 기준 서술이 남지만 전부 기본 축 경로라 모순이 아니다. **의도적 무갱신**(additive 원칙).

## 구현 지점

- `src/sync/machine.ts` — `ModelSyncHandle` 생성 시 `adapter.versionOf ?? (m => m.updatedAt)`을 확정해 보관. updatedAt 참조 지점은 **4곳**: `doPull()`의 워터마크 전진 1곳 + `applyOne()`의 incoming 가드·local 읽기·비교 3곳. 특히 incoming 가드는 `incoming?.id == null || incoming?.updatedAt == null` 결합 조건이므로 **id 가드는 유지**하고 updatedAt 부분만 치환할 것.
- `src/sync/types.ts` — 위 계약 추가 + `buildPull` 주석의 since 정의 갱신 + `SyncTarget.updatedAt` 주석을 "the freshness criterion"에서 "기본 versionOf가 읽는 필드"로 갱신.
- spec — 기존 it() 블록은 기본 versionOf로 그대로 통과해야 한다(회귀 게이트). seq 축 어댑터 케이스를 machine.spec의 관련 describe에 추가.

## 검증 시나리오 (Peer simulator)

검증 배선은 [01-design 검증 시나리오](./01-design.md#검증-시나리오-peer-simulator)와 동일하다(`sync/testing.ts` 브리지 + 서버 대역 `Peer`). 추가 spec은 machine.spec의 관련 describe에 붙인다.

1. **기본값 회귀**: versionOf 미주입 어댑터로 기존 spec 전량이 무수정 통과해야 한다 — 기본 versionOf가 v1의 updatedAt 판정과 동작 동일함의 증거이자 additive 보장 게이트.
2. **seq 축 e2e**: `versionOf: m => m.seq`인 어댑터(updatedAt 없는 대상)로 ① pull 반영 ② 낮거나 같은 seq 이벤트 무시, 높은 seq 반영 ③ 재tick 시 서버 대역이 받은 `buildPull(since)`의 since가 pull 반영분 `max(seq)`인지 확인 ④ `SyncTarget` 계약 무변경으로 수용됨을 확인한다.
3. **undefined 판정**: `versionOf(incoming)`이 undefined인 수신 모델은 무시되고, `versionOf(local)`이 undefined인 로컬 모델은 stale로 덮인다 — v1의 updatedAt 부재 규칙과 동형.
4. **워터마크 전진 규칙 유지**: seq 축에서도 이벤트 반영은 워터마크를 전진시키지 않는다 — 높은 seq 이벤트 반영 후 tick의 since가 이벤트 seq가 아니라 마지막 pull 반영분 max임을 확인한다(안전망 규칙의 축 독립성).
5. **deletedAt 직교**: seq 축에서 deletedAt 수신이 최신 판정 통과 시 스토어를 제거함을 확인한다 — 제거 규칙이 versionOf와 직교함의 증거. 반대로 축 값 없는 tombstone(seq 누락 삭제 이벤트)은 무시되어 삭제가 반영되지 않음도 함께 고정한다 — 서버 계약 전제 3의 위반 시 동작 명세.

## 비범위 (후속)

- **event-only 등록(pull 없는 타입)**: PR#9 progress consumer(`createProgressConsumer`, id별 seq LWW)를 sync machine 어댑터로 수렴시키려면 versionOf 외에 pull 계열(`buildPull`/`parseReply`)의 optional화가 필요하다 — progress는 이벤트 전용·단방향이고, `seq`가 reporter 단위 단조라 타입 전역 워터마크로 부적합하지만 pull이 없으면 워터마크 자체가 무의미하다. 또한 progress consumer는 L1 직결(raw filter)인데 머신은 L3를 요구하므로 수렴 시 경유 계층이 바뀐다. PR#9 미머지 상태이므로 수렴 검토는 머지 후로 보류한다 (2026-07-06 결정).
