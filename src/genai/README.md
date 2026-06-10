# GenAI

`src/genai`는 HTTP 기반 agents API를 Gemini 호환 `ai.models.generateContent()` 표면으로 사용하는 어댑터를 관리합니다.

프론트엔드(브라우저/Vite)와 백엔드(Node)가 **같은 타입과 행동을 공유**하도록 lemon-model 패키지로 제공됩니다.
원본은 `eureka-codes-api-1`의 `doPostRefactor`가 프론트엔드에 코드 생성으로 심던 GenAI shim과
`eureka-agents-api / src/lib/proxy`이며, 이제 양쪽 모두 이 모듈을 import해서 사용합니다.

```ts
// CJS(backend) / bundler(frontend) 공통
import { HttpAbstractGenAI, createProxyTransportReceiver } from 'lemon-model';
import { BrowserWebSocketNetwork, waitWebSocketConnectionId } from 'lemon-model';
```

## 목차

- [목표](#목표)
- [HttpAbstractGenAI](#httpabstractgenai)
- [변환 규칙](#변환-규칙)
- [테스트](#테스트)
- [Transport 응답](#transport-응답)
- [클라이언트 Transport 사용](#클라이언트-transport-사용)
- [클라이언트 주의사항](#클라이언트-주의사항)
- [Inline Image Dump Transport 예제](#inline-image-dump-transport-예제)
- [Browser Dump Test](#browser-dump-test)

## 목표

- 서버와 브라우저에서 동일하게 사용할 수 있도록 표준 `fetch`만 사용합니다. (axios, `import.meta` 등 런타임/모듈 시스템 의존 없음 → CJS 빌드로 F/B 모두 사용 가능)
- endpoint는 코드에 박지 않고 생성자 인자로 받습니다. (프론트는 `import.meta.env`, 백엔드는 `process.env`에서 읽어 주입)
- 현재는 Gemini `generateContent()` 호환성을 우선합니다.
- 추후 OpenAI 호환 proxy를 같은 폴더에 추가할 예정입니다.

## HttpAbstractGenAI

`HttpAbstractGenAI`는 `AbstractGenAI` 형태의 호출을 `POST /agents/!/generate` 호환 요청으로 변환합니다.
응답 복원은 공통 함수 `$gemini.asGenerateContentResponse()`를 사용합니다.

```ts
import { HttpAbstractGenAI } from 'lemon-model';

const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate');

const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: 'hello',
    config: {
        systemInstruction: '/dump',
        responseMimeType: 'application/json',
    },
});
```

## 변환 규칙

| Gemini-compatible params             | `/agents/!/generate` body |
| ------------------------------------ | ------------------------- |
| `model`                              | `model`                   |
| `contents: string`                   | `prompt`                  |
| `contents.parts[].text`              | `prompt`                  |
| `contents` with `inlineData`         | `prompt.content`          |
| `config.systemInstruction`           | `system`                  |
| `config` 나머지 필드                 | `config`                  |
| image 모델/inlineData/IMAGE modality | `image: true`             |

응답은 agents API의 `GenAIResponse`를 `ProxyGenAIGenerateContentResponse`로 복원합니다.

- `candidate.content.parts`는 그대로 `candidates[0].content.parts`가 됩니다.
- `output.content` 문자열은 text part가 됩니다.
- `output.content.data`가 일반 문자열이면 text part가 됩니다.
- `output.content.data`가 `data:<mime>;base64,<bytes>`이면 image `inlineData` part가 됩니다.

## 테스트

- `proxy.spec.ts`: `HttpAbstractGenAI`의 요청/응답 변환과 `/dump` 연결 검증
- `mocks.ts`: 테스트 helper (root barrel에서 제외 — `lemon-model/dist/genai/testing`으로 import)
    - `createAgentGenerateFetcher()`: controller-like 객체를 fetch처럼 호출
    - `MockAgentGenerateController`: `AgentAPIController.doPostGenerate()`의 `/dump` + transport 계약을 재현하는 in-memory 서버 대역
- WebSocket 브리지 기본 동작은 `../socket/websocket.spec.ts`가 담당합니다.

## Transport 응답

`transportId`를 사용하면 HTTP 응답 body 대신 WebSocket JSONTransport로 최종 `GenAIResponse`를 받을 수 있습니다.

```ts
const ai = new HttpAbstractGenAI('/agents/!/generate', {
    transportId: 'api-gateway-connection-id',
    transport: createProxyTransportReceiver(network),
});
```

이때 `HttpAbstractGenAI`는 `POST /agents/!/generate?transportId=...`를 호출합니다. 서버는 최종 응답을
`sendTransport(transportId, finalResponse)`로 전송하고, HTTP 응답은 전송 ack만 반환합니다.
클라이언트는 `transport.wait()`로 조립된 최종 payload를 받은 뒤 `$gemini.asGenerateContentResponse()`로 복원합니다.
수신기는 외부에서 제공된 `NetworkSupportable`에 listener를 등록하며, `json:manifest`, `json:chunk`,
`json:complete`, `json:error` 패킷만 JSONTransport로 전달합니다.

## 클라이언트 Transport 사용

클라이언트는 먼저 WebSocket 같은 실제 연결을 `NetworkSupportable` 형태로 준비합니다. 그 다음
`createProxyTransportReceiver(network)`를 만들고, 같은 연결의 connection id를 `HttpAbstractGenAI`의
`transportId`로 전달합니다.

```ts
import {
    BrowserWebSocketNetwork,
    HttpAbstractGenAI,
    createProxyTransportReceiver,
    waitWebSocketConnectionId,
} from 'lemon-model';
```

사용 순서는 다음과 같습니다.

```ts
const ws = new WebSocket('wss://example.com/socket?v2');
const network = new BrowserWebSocketNetwork(ws);
await network.ready();

const connectionId = await waitWebSocketConnectionId(ws, {
    connectMessage: 'device.save',
    timeoutMs: 15_000,
});

const transport = createProxyTransportReceiver(network, {
    timeoutMs: 30_000,
});

const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
    transportId: connectionId,
    transport,
});

const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: 'hello',
    config: {
        systemInstruction: '/dump',
    },
});
```

이 호출은 내부적으로 `POST /agents/!/generate?transportId=<connectionId>`를 실행합니다. HTTP 응답은 ack 용도이고,
실제 `GenAIResponse`는 같은 connection id로 전달되는 JSONTransport 패킷에서 조립됩니다.

`waitWebSocketConnectionId()`는 WSS가 open 된 뒤 `connectMessage`를 보내고, 응답 메시지에서 다음 형태의 값을
표준 connection id 후보로 조회합니다.

- `connectionId`
- `connId`
- `data.connectionId`
- `data.connId`
- `data.connId.id`
- `data.id`
- `body.connectionId`
- `body.connId`
- `body.id`
- `id`

## 클라이언트 주의사항

- `transportId`는 서버가 WebSocket으로 응답을 보낼 수 있는 실제 connection id여야 합니다.
- `transportId`를 설정하면 `transport`도 반드시 함께 제공해야 합니다.
- `NetworkSupportable.onMessage()`는 raw string packet을 그대로 전달해야 합니다.
- `createProxyTransportReceiver()`는 transport 관련 패킷만 사용하므로, 같은 WebSocket에서 다른 메시지가 섞여도 무시됩니다.
- 하나의 `JSONProxyTransportReceiver`는 동시에 하나의 `wait()`만 처리합니다. 병렬 generate가 필요하면 요청별 receiver를 분리하거나 큐잉 계층을 둡니다.
- 응답을 기다리던 중 timeout이 발생하면 generate 호출은 실패합니다.
- 브라우저 `Window.fetch`는 호출 컨텍스트가 필요할 수 있으므로, proxy 내부에서는 `globalThis` 컨텍스트로 호출합니다.
- `BrowserWebSocketNetwork`는 외부에서 받은 WebSocket을 소유하지 않습니다. `close()`는 실제 WebSocket을 닫지 않고 listener를 해제하는 `detach()`로 동작합니다.
- receiver를 폐기할 때는 `transport.detach()`를 호출할 수 있습니다.

## Inline Image Dump Transport 예제

인라인 이미지를 포함한 요청이 `/dump` 결과로 WebSocket transport를 통해 돌아오는지는
`src/genai/proxy.spec.ts`의 다음 테스트를 기준으로 확인합니다.

```ts
import { createNetwork } from 'lemon-model/dist/socket/testing';
import { createAgentGenerateFetcher, MockAgentGenerateController } from 'lemon-model/dist/genai/testing';

const network = createNetwork();
const receiver = createProxyTransportReceiver(network, { timeoutMs: 1000 });

const controller = new MockAgentGenerateController({
    sendTransport: async (transportId, payload) => {
        const sender = createJSONTransport(network);
        sender.send(payload);
        sender.detach();
        return { result: true, packets: 1, connectionId: transportId };
    },
});

const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
    fetch: createAgentGenerateFetcher(controller, { domain: 'localhost' }),
    transportId: 'transport-inline-dump-1',
    transport: receiver,
});

const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-image-preview',
    contents: {
        parts: [
            { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } },
            { text: 'make a banner from this inline image' },
        ],
    },
    config: {
        systemInstruction: '/dump',
        responseModalities: ['IMAGE', 'TEXT'],
    },
});

const dumped = JSON.parse(response.text ?? '{}');
```

주의해서 볼 사항은 다음 정도입니다.

- `HttpAbstractGenAI` 요청 URL은 `transportId`를 포함해야 합니다.
- HTTP 응답은 ack이고, 최종 dump payload는 `sendTransport()`가 보낸 JSONTransport 패킷에서 조립됩니다.
- `createProxyTransportReceiver()`는 `json:manifest`, `json:chunk`, `json:complete`, `json:error`만 사용합니다.
- `/dump` 결과의 `contents.parts[0].inlineData.data`는 전체 base64가 아니라 앞부분만 잘린 값으로 검증합니다.
- `dumped.$param.isImage === true`와 `responseModalities`가 유지되는지 확인합니다.
- 테스트 종료 시 `receiver.detach()`와 `network.close()`를 호출해 대기 listener를 정리합니다.

## Browser Dump Test

브라우저 UI에서 transport 루프를 빠르게 점검할 때는 `browserWebSocketDumpTest()`를 사용할 수 있습니다.
(upstream의 `BrowserWebSocketNetwork.dumpTest()`와 동일 — 브리지가 socket 코어로 분리되며 standalone 함수가 되었습니다.)
이 함수는 WebSocket connection id 조회, `/agents/!/generate?transportId=...` 호출, JSONTransport 수신,
`/dump` 결과 검증을 한 번에 수행합니다.

```ts
import { browserWebSocketDumpTest } from 'lemon-model';

const result = await browserWebSocketDumpTest({
    ws: new WebSocket('wss://example.com/socket?v2'),
    endpoint: 'http://localhost:8830/agents/!/generate',
    connectMessage: 'device.save',
    log: entry => console.log(entry.event, entry.data),
});

console.log(result.ok, result.checks, result.dumped);
```

입력 가능한 주요 옵션은 다음입니다.

- `ws` 또는 `wsUrl`: 외부에서 만든 WebSocket 또는 연결 URL
- `endpoint`: generate API endpoint
- `fetch`, `headers`: 브라우저/테스트 환경용 HTTP 호출 설정
- `model`, `prompt`, `imageBase64`, `imageMimeType`: dump 테스트 요청 데이터
- `timeoutMs`: connection id 및 transport 응답 대기 시간
- `close`: `wsUrl`로 내부 생성한 WebSocket은 기본적으로 닫고, 외부 `ws`는 기본적으로 닫지 않습니다.
- `log`: UI에 표시할 단계별 로그 callback

반환값의 `checks`에서 `ackTransport`, `dumpParsed`, `inlineDataTruncated`, `imageRequestMarked`,
`responseModalitiesKept` 등을 확인하면 UI 연결 상태를 빠르게 판별할 수 있습니다.
