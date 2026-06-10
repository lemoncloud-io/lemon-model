# JSONTransport Spec

This document describes a planned JSON-based transport layer for `lib/socket`.

The goal is to send GenAI-oriented JSON object responses over an existing `NetworkSupportable` while preserving the response shape as much as possible. Large leaf values, such as inline image strings or long model output, can be split into chunks and delivered separately. The receiver reconstructs the original response object after all required parts arrive.

This is not intended to support every possible JSON document equally well. It is optimized for the response patterns produced by LLM, image, tool-call, and multimodal agent flows.

## Problem

`NetworkSupportable.send(data: string)` models a low-level network packet. It has realistic constraints:

- packet size can be limited
- delivery is asynchronous
- delivery order is not guaranteed
- fire-and-forget sends may fail asynchronously

Plain `JSON.stringify(data)` can exceed packet limits when GenAI responses contain large string fields.

Common GenAI examples:

- inline image data: `data:image/png;base64,...`
- generated image payloads returned as base64
- long assistant text or markdown
- long tool output or tool result JSON serialized into a string field
- large markdown/document content
- multimodal response parts with large `text`, `inlineData`, `output`, or `content` fields
- embedded transcript or message history snapshots

We need a transport that can preserve the response object shape while splitting only the large parts.

## Feasibility

This is feasible with two clearly separated layers:

- `NetworkSupportable`: raw string packet delivery with network-like constraints.
- `JSONTransport`: JSON framing, chunking, buffering, and reassembly over that network.

The transport protocol is:

1. Send a small JSON manifest that preserves the original response shape.
2. Replace large leaf values with references.
3. Send referenced large values as chunk packets.
4. Reassemble chunks by id.
5. Restore references in the manifest to rebuild the original JSON.

This approach is practical for GenAI responses because they usually have a predictable tree structure. Large values normally appear as leaf strings. We can replace those leaves without changing the surrounding response structure.

## Target Payloads

The first implementation should focus on GenAI response objects rather than arbitrary JSON data.

Representative payload shapes:

```ts
interface GenAITextResponse {
    type: 'text';
    data: {
        text: string;
        model?: string;
        usage?: {
            inputTokens?: number;
            outputTokens?: number;
        };
    };
}

interface GenAIImageResponse {
    type: 'image';
    data: {
        mimeType: string;
        inlineData: string;
        prompt?: string;
    };
}

interface GenAIToolResponse {
    type: 'tool-result';
    data: {
        name: string;
        output: string;
        status?: 'ok' | 'error';
    };
}

type GenAITransportPayload = GenAITextResponse | GenAIImageResponse | GenAIToolResponse;
```

Expected characteristics:

- top-level value is an object
- nested arrays and objects describe response structure
- unusually large values are usually strings
- base64 and markdown strings are common
- binary data is already encoded by the caller
- cyclic data, class instances, and rich JavaScript objects are outside the target

## Non-Goals

Initial implementation should not try to stream every JSON shape or arbitrary JavaScript object graph.

- GenAI response-like JSON objects only
- no cyclic object support
- no `Map`, `Set`, `Date`, `BigInt`, class instances, or binary buffers unless encoded by caller
- no attempt to preserve object prototypes or special JavaScript values
- no general-purpose JSON patch/diff support
- no compression in the first version
- no persistence across process restarts

## Role Separation

`NetworkSupportable` and `JSONTransport` should not represent the same responsibility.

`NetworkSupportable` owns network behavior:

- raw `string` packets only
- packet size checks
- latency and jitter
- unordered delivery
- raw packet receive subscription with `onMessage`
- connection lifecycle with `readyState` and `close`
- low-level async delivery errors with `onError`

`JSONTransport` owns JSON behavior:

- accepts typed JSON object values
- serializes transport packets into raw strings
- splits large JSON leaf values into chunks
- buffers out-of-order transport packets
- reassembles complete JSON values
- emits rebuilt JSON values to application handlers
- reports JSON framing/reassembly errors

`JSONTransport` should use an underlying `NetworkSupportable`; it should not be treated as a replacement network.

For GenAI usage, `JSONTransport` should be understood as a response transport. It is not a schema validator, not a general JSON database serializer, and not a replacement for streaming token protocols.

## Transport Shape

`JSONTransportSupportable<T extends object>` should stay small and should expose the underlying network explicitly.

```ts
interface JSONTransportSupportable<T extends object> {
    readonly network: NetworkSupportable;

    send(data: T): void;
    configure?(options: JSONTransportOptions): void;
    onMessage(handler: (data: T) => void): SocketUnsubscribe;
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    readonly pendingCount: number;
    cleanup(now?: number): number;
    detach(): void;
}

function createJSONTransport<T extends object>(
    network: NetworkSupportable,
    options?: JSONTransportOptions,
): JSONTransportSupportable<T>;
```

Usage shape:

```ts
interface ImagePayload {
    type: 'image';
    data: {
        inlineData: string;
        mimeType: string;
    };
}

const network: NetworkSupportable = createNetwork();
const transport = createJSONTransport<ImagePayload>(network);

transport.onMessage(data => {
    // receive rebuilt JSON value
    data.data.inlineData;
});

transport.send({
    type: 'image',
    data: {
        mimeType: 'image/png',
        inlineData: 'data:image/png;base64,...large...',
    },
});
```

Compatibility note:

- `JSONTransport.send(data)` is a transport-level API, not `NetworkSupportable.send(data)`.
- `NetworkSupportable.send(data)` accepts only raw strings.
- `JSONTransport.send(data)` accepts typed `T` values.
- Serialized strings are only used internally for transport packets sent through `network.send(string)`.
- Internally, every JSON transport packet is serialized and sent with `network.send(string)`.
- Network lifecycle remains available through `transport.network.readyState` and `transport.network.close()`.
- Network condition updates remain available through `transport.network.configure?.(...)`.

## Packet Types

All packets sent through the underlying network should be strings containing JSON packet envelopes.

Recommended packet shape:

```ts
type JSONTransportPacket =
    | JSONManifestPacket
    | JSONChunkPacket
    | JSONCompletePacket
    | JSONErrorPacket;

interface JSONManifestPacket {
    type: 'json:manifest';
    tid: string;
    root: any;
    refs: JSONChunkRef[];
}

interface JSONChunkPacket {
    type: 'json:chunk';
    tid: string;
    cid: string;
    index: number;
    total: number;
    data: string;
    hash: string;
}

interface JSONCompletePacket {
    type: 'json:complete';
    tid: string;
}

interface JSONErrorPacket {
    type: 'json:error';
    tid: string;
    error: string;
}
```

Fields:

- `tid`: transport message id. Groups manifest and chunks.
- `cid`: chunked value id. Identifies one large leaf value.
- `index`: chunk sequence number for a single `cid`.
- `total`: total chunk count for that `cid`.
- `data`: chunk string payload.
- `hash`: short non-cryptographic hash of `data`.
- `root`: original JSON with large leaf values replaced by refs.
- `refs`: metadata for chunked values.

The chunk hash is a lightweight safety check against accidental data mismatch or corruption. It is not cryptographic authentication and should not be treated as a security boundary.

## Reference Shape

Large leaf values should be replaced in `root` with small marker objects.

```ts
interface JSONChunkRef {
    cid: string;
    path: string;
    encoding: 'utf8' | 'base64' | string;
    size: number;
    chunks: number;
}

type JSONRefMarker = {
    $jsonTransportRef: string;
};
```

Example:

Input:

```json
{
  "type": "image",
  "data": {
    "mimeType": "image/png",
    "prompt": "cat",
    "inlineData": "data:image/png;base64,....very large...."
  }
}
```

Manifest root:

```json
{
  "type": "image",
  "data": {
    "mimeType": "image/png",
    "prompt": "cat",
    "inlineData": { "$jsonTransportRef": "chunk-1" }
  }
}
```

Refs:

```json
[
  {
    "cid": "chunk-1",
    "path": "/data/inlineData",
    "encoding": "utf8",
    "size": 123456,
    "chunks": 8
  }
]
```

The path uses JSON Pointer style paths.

## Splitting Rules

Only leaf values should be split in the first version.

Recommended default split candidates:

- strings above `largeValueBytes`
- strings at GenAI-heavy paths such as `/data/text`, `/data/content`, `/data/output`, `/data/inlineData`, `/data/parts/*/text`, or `/data/parts/*/inlineData`
- optionally other string paths selected by user-provided predicate

Arrays and objects should not be serialized as chunk payloads by default. In GenAI responses, arrays and objects usually describe structure, while the expensive payload is normally a string leaf.

Default:

```ts
interface JSONTransportOptions {
    largeValueBytes?: number;
    chunkBytes?: number;
    envelopeReserveBytes?: number;
    preferredSplitPaths?: string[];
    identityProvider?: JSONTransportIdentityProvider;
    partialTtlMs?: number;
    cleanupIntervalMs?: number;
    logger?: SocketLogger;
    split?: (path: string, value: any, size: number) => boolean;
}

interface JSONTransportIdentityProvider {
    nextTransportId(): string;
    nextChunkId(): string;
}
```

Recommended defaults:

- `largeValueBytes`: 16 * 1024
- `chunkBytes`: configured by caller or derived from a conservative default
- `envelopeReserveBytes`: 1024
- `preferredSplitPaths`: GenAI response paths likely to contain large output strings
- `identityProvider`: default provider is available; tests can inject deterministic ids
- `partialTtlMs`: incomplete receive states expire after a bounded time; set 0 to disable cleanup
- `cleanupIntervalMs`: optional automatic cleanup interval; default 0 keeps cleanup opportunistic/manual
- `logger`: optional structured logger for JSON packet send/receive, assembly, cleanup, and errors

Important:

- `NetworkSupportable` does not expose `maxPacketBytes`.
- Therefore standalone `JSONTransport` cannot infer the exact network packet limit.
- The caller should configure `chunkBytes` when the network has a small `maxPacketBytes`.
- If `network.send(packet)` throws `1009: message too big`, the transport should surface that as a send failure.

## Send Flow

1. Accept `data: T`.
2. Walk the JSON tree.
3. For each large leaf:
   - allocate `cid`
   - replace the leaf with `{ $jsonTransportRef: cid }`
   - create chunk packets
4. Create a `json:manifest` packet.
5. Create a `json:complete` packet.
6. For each transport packet:
   - serialize it with `JSON.stringify(packet)`
   - send it through `network.send(packetString)`

The normal send order can be manifest, chunks, complete, but the receiver must not depend on that order.

Important:

- The underlying `NetworkSupportable` may reorder packets.
- The receiver cannot assume manifest arrives before chunks.
- The receiver must buffer packets by `tid`.

## Receive Flow

1. Subscribe to raw packets with `network.onMessage(...)`.
2. Parse each raw network packet as `JSONTransportPacket`.
3. Store packet state by `tid`.
4. If a manifest arrives:
   - store `root`
   - store expected refs
5. If a chunk arrives:
   - store by `tid`, `cid`, and `index`
6. If complete arrives:
   - mark the transport message complete
7. Try to assemble whenever state changes.
8. Assembly succeeds only when:
   - manifest is present
   - complete is present
   - every ref has every chunk
9. Rebuild all chunked values.
10. Replace all ref markers in `root`.
11. Emit the rebuilt JSON value via transport `onMessage`.

## Ordering

The protocol must be order-independent.

Valid arrival orders include:

- manifest, chunks, complete
- chunks, manifest, complete
- complete, chunks, manifest
- interleaved chunks from multiple `tid`s

Ordering is restored by `tid`, `cid`, and `index`.

## Error Handling

JSONTransport should emit JSON-layer errors through `onError`.

Network-layer async errors remain owned by the underlying network. A practical implementation can subscribe to `network.onError(...)` and forward those errors with the original context plus a JSON transport scope, but it should not hide the underlying network from callers.

When `logger` is provided, JSONTransport should emit structured logs for send, receive, assembly, cleanup, detach, and JSON/network errors. Required log fields are `time`, `level`, `message`, and `location`; entries should include `networkId` and transport metadata such as `tid` where useful.

Recommended error scopes:

- `json.parse`: packet is not valid JSON
- `json.packet`: packet shape is invalid
- `json.chunk.duplicate`: duplicate chunk index
- `json.chunk.ref`: chunk references an unknown manifest ref
- `json.chunk.total`: chunk total does not match manifest ref metadata
- `json.chunk.missing`: complete message cannot be assembled
- `json.manifest.duplicate`: duplicate manifest for a transport id
- `json.ref.duplicate`: manifest contains duplicate ref ids
- `json.ref.missing`: manifest references a missing chunk value
- `json.ref.path`: ref path cannot be restored
- `json.ref.size`: assembled chunk size does not match ref metadata
- `json.send`: underlying network send failed

For `send(data)`:

- immediate serialization errors should throw synchronously
- underlying `network.send(...)` errors that happen synchronously should throw
- async delivery errors from the network are observed through `network.onError(...)`

## Packet Size Strategy

`JSONTransport` should not blindly rely on network packet limits.

Because packet envelopes add overhead, chunk payload size should be smaller than the max packet size.

Recommended calculation:

```ts
chunkBytes = maxPacketBytes - envelopeReserveBytes
```

Where:

- `maxPacketBytes` is the actual network configuration known by the caller or by `Peer`
- `envelopeReserveBytes` defaults to 1024
- minimum `chunkBytes` should be validated

Because `NetworkSupportable` does not expose current network options, standalone transports should receive `chunkBytes` directly:

```ts
const network = createNetwork({ maxPacketBytes: 4096 });
const transport = createJSONTransport<Record<string, unknown>>(network, {
    chunkBytes: 4096 - 1024,
});
```

When `JSONTransport` is enabled through `Peer`, the peer keeps this simpler:

- `PeerOptions.maxPacketBytes` configures the real network packet limit.
- `JSONTransportOptions.chunkBytes` can override the chunk size.
- If `chunkBytes` is omitted, `Peer` derives it internally from `maxPacketBytes`.

TODO: If a manifest itself is too large:

- attempt to split large leaves first
- if still too large, throw `1009: message too big`
- next improvement: split manifests into pages

## Implementation Decisions

The first implementation should keep the scope intentionally narrow.

- Split only string leaf values by default, with GenAI-heavy fields as the primary target.
- Preserve arrays and objects as structure in the manifest.
- Do not split manifest packets in the first version.
- Treat `send(data: T)` as fire-and-forget, matching `NetworkSupportable.send(...)`.
- Reassembled values are emitted through transport `onMessage(handler)`.
- Keep `Peer` integration out of the first implementation.
- Store receiver state in memory only.
- Use deterministic id generation helpers in tests where possible.
- Prefer payloads that look like agent/model responses over arbitrary JSON documents.

These choices avoid mixing transport framing with peer request/result semantics. `Peer.send()` already owns request correlation with `mid`; `JSONTransport` should only make large JSON values fit through raw string packet constraints.

## Detailed Development Plan

### Phase 1: Types

Add transport-specific types in `src/lib/socket/types.ts` or a dedicated `json-transport.ts` export surface.

Required types:

```ts
export interface JSONTransportSupportable<T extends object> {
    readonly network: NetworkSupportable;

    send(data: T): void;
    configure?(options: JSONTransportOptions): void;
    onMessage(handler: (data: T) => void): SocketUnsubscribe;
    onError(handler: SocketErrorHandler): SocketUnsubscribe;
    readonly pendingCount: number;
    cleanup(now?: number): number;
}

export interface JSONTransportOptions {
    largeValueBytes?: number;
    chunkBytes?: number;
    envelopeReserveBytes?: number;
    preferredSplitPaths?: string[];
    identityProvider?: JSONTransportIdentityProvider;
    partialTtlMs?: number;
    cleanupIntervalMs?: number;
    logger?: SocketLogger;
    split?: (path: string, value: unknown, size: number) => boolean;
}

export interface JSONTransportIdentityProvider {
    nextTransportId(): string;
    nextChunkId(): string;
}
```

Packet types:

- `JSONTransportPacket`
- `JSONManifestPacket`
- `JSONChunkPacket`
- `JSONCompletePacket`
- `JSONErrorPacket`
- `JSONChunkRef`
- `JSONRefMarker`
- `JSONTransportIdentityProvider`
- `JSONTransportSizeSummary`

Acceptance checks:

- Types compile without touching `@types`.
- `JSONTransportSupportable<T>` keeps `send(data: T)` and `onMessage(handler: (data: T) => void)`.
- `NetworkSupportable` remains the raw string network contract.

### Phase 2: Pure JSON Helpers

Implement pure helper functions before adding network behavior.

Suggested helpers:

```ts
splitJSON<T extends object>(data: T, options: RequiredJSONTransportOptions): JSONSplitResult;
assembleJSON<T extends object>(state: JSONReceiveState): T | undefined;
summarizeJSONTransportSize<T extends object>(...): JSONTransportSizeSummary;
```

`splitJSON(...)` should:

- walk plain JSON arrays and objects
- calculate string byte size with a runtime-neutral UTF-8 byte counter, such as `TextEncoder`
- replace large string leaves with `{ $jsonTransportRef: cid }`
- create `JSONChunkRef` metadata
- create chunk payloads for each ref
- leave small strings and other primitive values unchanged
- treat GenAI response fields such as `text`, `content`, `output`, and `inlineData` as the main expected split targets

`assembleJSON(...)` should:

- require manifest, complete marker, and all referenced chunks
- join chunk strings by ascending `index`
- restore each ref marker into the manifest root
- return `undefined` until the message is complete
- avoid mutating caller-owned inputs unless that is explicitly documented

`splitJSON(...)` should also expose a size summary:

```ts
interface JSONSplitResult {
    tid: string;
    manifest: JSONManifestPacket;
    chunks: JSONChunkPacket[];
    complete: JSONCompletePacket;
    size: JSONTransportSizeSummary;
    summarize(): JSONTransportSizeSummary;
    send(network: NetworkSupportable): void;
}

interface JSONTransportSizeSummary {
    originalBytes: number;
    manifestBytes: number;
    chunkBytes: number[];
    completeBytes: number;
    totalPacketBytes: number;
    overheadBytes: number;
}
```

Expected size behavior:

- `splitJSON(data)` should not eagerly serialize every packet just to calculate byte summary.
- `JSONSplitResult.size` and `JSONSplitResult.summarize()` calculate the summary lazily.
- `JSONSplitResult.send(network)` serializes and sends packets only when the caller actually wants to transmit them.
- `assembleJSON(splitJSON(data))` rebuilds the same logical payload, so the reconstructed object should have the same `JSON.stringify(...)` size as the original.
- `manifestBytes` is usually much smaller than the original for very large `inlineData`, `text`, or `output` fields.
- `manifestBytes` can be larger than the original for small payloads because the manifest includes transport envelope and ref metadata.
- `totalPacketBytes` is normally larger than `originalBytes` because every chunk carries packet envelope fields.
- `overheadBytes` is the cost of making the response deliverable under packet limits.
- The important network constraint is per-packet size, not total transferred bytes.

Acceptance checks:

- No network object is needed to test these helpers.
- Injected `identityProvider` produces deterministic `tid` and `cid` values.
- Size summary explains original bytes, manifest bytes, chunk packet bytes, total packet bytes, and overhead bytes.
- A representative GenAI text response round-trips.
- A representative GenAI image response with large `inlineData` round-trips.
- A representative tool-result response with large `output` round-trips.
- Large strings inside response `parts` arrays round-trip.
- Small payloads produce zero refs and still round-trip.

### Phase 3: JSONTransport Class

Implement a class similar to:

```ts
export class JSONTransport<T extends object> implements JSONTransportSupportable<T> {
    public readonly network: NetworkSupportable;

    public send(data: T): void;
    public configure(options: JSONTransportOptions): void;
    public onMessage(handler: (data: T) => void): SocketUnsubscribe;
    public onError(handler: SocketErrorHandler): SocketUnsubscribe;
    public readonly pendingCount: number;
    public cleanup(now?: number): number;
}
```

Constructor behavior:

- store the underlying `NetworkSupportable`
- merge options with defaults
- subscribe to `network.onMessage(packet => this.receive(packet))`
- optionally subscribe to `network.onError(...)` and forward with JSON transport context

`send(data)` behavior:

- split the object into manifest and chunks
- serialize each transport packet
- send each packet through `network.send(...)`
- throw synchronous serialization or `network.send(...)` errors

`receive(packetString)` behavior:

- parse packet JSON
- validate the packet shape
- validate manifest refs, duplicate ids, ref paths, and chunk/ref consistency
- emit structured logs when a logger is configured
- update receive state by `tid`
- try assembly after every packet
- emit exactly one rebuilt `T` when complete
- cleanup completed `tid` state
- expose `pendingCount`
- expose `cleanup(now?)` to remove expired partial messages without waiting for more packets
- optionally run cleanup on `cleanupIntervalMs`

Acceptance checks:

- `JSONTransport` never calls peer APIs.
- `JSONTransport` never assumes packet delivery order.
- Closing still belongs to `transport.network.close()`.
- Network condition changes still belong to `transport.network.configure?.(...)`.

### Phase 4: Exports

Add public exports from `src/lib/socket/index.ts`.

Expected export shape:

- `JSONTransport`
- `createJSONTransport`
- JSON transport types
- pure helpers if they are useful for tests or advanced callers

Acceptance checks:

- Existing socket imports keep working.
- Existing socket tests keep passing.
- No changes are made outside `src/lib/socket`.

### Phase 5: Peer Integration

`Peer` can optionally use JSON transport for the full socket message envelope.

Integration behavior:

- `Peer` continues sending `{ type, data, mid }`.
- `JSONTransport<SocketMessage<T>>` wraps peer messages only when the sending peer enables `jsonTransport`.
- `mid` remains inside the JSON object and is not interpreted by `JSONTransport`.
- The default peer path still sends raw `JSON.stringify(message)` through `NetworkSupportable`.
- Sender-side peer code uses `splitJSON(message).send(network)` to avoid creating a receiver on its own outbound network.
- Receiver-side peer code attaches a `JSONTransport` decoder with `createJSONTransport(network).onMessage(...)`.
- Peer links retain receiver-side decoders and call `detach()` during close/detach cleanup.

This keeps `JSONTransport` free from request/result semantics while allowing large GenAI payloads to pass through peer request/result flows.

## Implementation Risks

### Packet Size Risk

The manifest can still exceed `NetworkSupportable` packet limits if a GenAI response contains huge structured metadata, many candidates, or a large message history snapshot made of many small fields.

Mitigation:

- first version throws `1009: message too big`
- tests should include this failure
- future version can add manifest paging
- callers should avoid sending full conversation history snapshots through this transport unless needed

### UTF-8 Chunk Boundary Risk

Splitting JavaScript strings by character count can produce packet byte sizes that exceed `chunkBytes` because UTF-8 characters can be multi-byte. This matters for generated Korean text, markdown, and tool output. Base64 image strings are usually ASCII, but text responses are not.

Mitigation:

- chunk by byte budget, not naive character count
- verify with Korean text and emoji-like multi-byte data if Unicode support is expected
- if implementation keeps ASCII/base64 as the primary target, document that assumption

### Ref Marker Collision Risk

User data may naturally contain an object like `{ "$jsonTransportRef": "..." }`.

Mitigation:

- only treat markers at paths listed in manifest `refs` as transport refs
- never scan arbitrary user objects as refs without metadata

### Out-of-Order And Duplicate Risk

Network jitter can deliver chunks before manifest or duplicate packet indexes may appear in manual tests.

Mitigation:

- store chunks by `tid/cid/index`
- tolerate chunks before manifest
- emit `json.chunk.duplicate` for duplicate indexes
- emit only once per completed `tid`

### Memory Growth Risk

Incomplete transfers can remain buffered forever.

Mitigation:

- support `partialTtlMs` for bounded incomplete receive states
- perform stale cleanup opportunistically when packets arrive, without a background interval
- optionally enable background cleanup with `cleanupIntervalMs`
- clear receive state after successful assembly
- clear listeners and buffered state when the transport is detached
- tests can manually verify completed state cleanup

### Serialization Cost Risk

Repeated `JSON.stringify(...)` for the same packets can waste CPU, especially for large GenAI responses.

Mitigation:

- keep `splitJSON(...)` focused on structural split work
- expose `JSONSplitResult.send(network)` so packet serialization happens only during actual transmission
- expose size summary lazily through `size` or `summarize()`, instead of calculating packet sizes for every split
- avoid using size summary on hot paths unless diagnostics require it

### Type Runtime Validation Risk

`T extends object` is compile-time only. Reassembled data may not actually match the expected GenAI response shape.

Mitigation:

- do not pretend runtime schema validation exists
- optionally allow `validate?: (data: unknown) => data is T` in a later version
- keep response types narrow in tests so mistakes are visible

### Error Propagation Risk

Network async errors and JSON-layer errors have different owners.

Mitigation:

- synchronous `send()` failures throw
- JSON parse/packet/assembly errors emit through transport `onError`
- underlying network async errors remain observable through `network.onError`
- optional forwarding must preserve the original context

## Verification Scenarios

### Helper Tests

1. Small text response:
   - input: `{ type: 'text', data: { text: 'hello', model: 'test' } }`
   - expected: zero refs, rebuilt object equals input

2. Long assistant markdown:
   - input contains `{ type: 'text', data: { text: longMarkdown } }`
   - expected: one ref, multiple chunks, rebuilt object equals input

3. Inline image response:
   - input contains `{ type: 'image', data: { mimeType: 'image/png', inlineData: largeBase64 } }`
   - expected: `inlineData` is chunked and restored exactly

4. Tool output response:
   - input contains `{ type: 'tool-result', data: { name: 'search', output: largeOutput } }`
   - expected: `output` is chunked and restored exactly

5. Multimodal parts array:
   - input contains `{ type: 'message', data: { parts: [{ text: longText }, { inlineData: largeBase64 }] } }`
   - expected: JSON Pointer paths point to array positions and restoration succeeds

6. Multiple large GenAI fields:
   - input contains `text`, `inlineData`, and `output` fields
   - expected: separate `cid`s and all fields restored correctly

7. Ref marker collision:
   - input contains a normal field `{ "$jsonTransportRef": "user-value" }`
   - expected: preserved as user data unless listed in `refs`

### Transport Delivery Tests

1. Basic transport round-trip:
   - connect sender network to receiver transport
   - send a typed GenAI text response
   - receiver `onMessage` receives the same object

2. Out-of-order packets:
   - use `Network` with unordered delivery and jitter
   - send a large inline image response
   - receiver still reconstructs correctly

3. Chunks before manifest:
   - manually call receiver with chunk packets before manifest
   - expected: no message emitted until manifest and complete arrive

4. Complete before chunks:
   - deliver `json:complete` first
   - expected: no message emitted until all chunks arrive

5. Interleaved transfers:
   - send a large text response and a large image response back-to-back
   - expected: both responses reconstruct without mixed chunks

6. Packet too big:
   - configure network `maxPacketBytes` smaller than serialized manifest for a huge candidate list
   - expected: `send()` throws `1009: message too big`

7. Duplicate chunk:
   - deliver the same `tid/cid/index` twice
   - expected: transport emits `json.chunk.duplicate`

8. Invalid packet JSON:
   - deliver a raw non-JSON packet
   - expected: transport emits `json.parse`

9. Invalid packet shape:
   - deliver `{ type: 'json:chunk' }` with missing fields
   - expected: transport emits `json.packet`

10. Listener unsubscribe:
    - subscribe then unsubscribe `onMessage`
    - expected: completed transfer does not call removed handler

11. Network close behavior:
    - call `transport.network.close()`
    - expected: later `transport.send(data)` throws network connection error

### Type-Level Checks

These can be covered by TypeScript compile checks or inline examples.

```ts
interface Payload {
    type: 'image';
    data: { inlineData: string; mimeType: string };
}

const transport = createJSONTransport<Payload>(network);

transport.send({ type: 'image', data: { inlineData: 'x', mimeType: 'image/png' } });
transport.onMessage(payload => payload.data.inlineData);
```

Expected compile-time behavior:

- `transport.send(...)` requires `Payload`
- `transport.onMessage(...)` receives `Payload`
- `transport.send('raw-json-string')` is not allowed

## Minimal Success Criteria

- `JSONTransportSupportable<T extends object>` uses `send(data: T)` and `onMessage(handler: (data: T) => void)`.
- A GenAI response object containing a large string can be sent under a small packet limit.
- The receiver reconstructs a response object deeply equal to the original.
- Out-of-order chunk delivery still reconstructs correctly.
- Interleaved transfers do not corrupt each other.
- Errors are observable through transport `onError` or the underlying `network.onError`, depending on ownership.
