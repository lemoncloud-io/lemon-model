/**
 * `genai/dump-test.ts`
 * - Browser-facing diagnostic loop for WebSocket transport generate dumps.
 * - upstream exposed this as `BrowserWebSocketNetwork.dumpTest()`; here the bridge lives in the
 *   shared socket core, so use the standalone `browserWebSocketDumpTest()` instead.
 *
 * @origin eureka-agents-api / src/lib/proxy/dump-test.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { BrowserWebSocketNetwork, WebSocketCompatible, waitWebSocketConnectionId } from '../socket/websocket';
import { createProxyTransportReceiver } from './transport';

/** single structured log entry emitted by browser dump tests */
export interface BrowserWebSocketDumpTestLogEntry {
    time: string;
    level: 'info' | 'error';
    event: string;
    data?: Record<string, unknown>;
}

/** options for `browserWebSocketDumpTest()` */
export interface BrowserWebSocketDumpTestOptions {
    /** externally owned WebSocket-compatible object */
    ws?: WebSocketCompatible;
    /** URL used when `ws` is not supplied */
    wsUrl?: string;
    /** `/agents/!/generate` compatible endpoint */
    endpoint?: string;
    /** fetch override for tests or sandboxed browser runtimes */
    fetch?: typeof fetch;
    /** extra HTTP headers for the generate trigger request */
    headers?: Record<string, string>;
    /** connection-id handshake message */
    connectMessage?: string;
    /** shared timeout for WebSocket and transport waits */
    timeoutMs?: number;
    /** image-capable model used for the dump request */
    model?: string;
    /** prompt text paired with the inline image */
    prompt?: string;
    /** inline image base64 used by the dump test */
    imageBase64?: string;
    /** inline image MIME type */
    imageMimeType?: string;
    /** close the WebSocket after the test; defaults to true only for internally created sockets */
    close?: boolean;
    /** callback for UI-visible progress logs */
    log?: (entry: BrowserWebSocketDumpTestLogEntry) => void;
}

/** result returned by `browserWebSocketDumpTest()` for UI diagnostics */
export interface BrowserWebSocketDumpTestResult {
    ok: boolean;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    endpoint: string;
    transportId: string;
    request: {
        url: string;
        body: Record<string, unknown>;
    };
    ack?: unknown;
    response?: object;
    dumped?: any;
    checks: {
        ackTransport: boolean;
        hasOutputText: boolean;
        dumpParsed: boolean;
        modelMatches: boolean;
        inlineMimeTypeMatches: boolean;
        inlineDataTruncated: boolean;
        promptTextMatches: boolean;
        imageRequestMarked: boolean;
        responseModalitiesKept: boolean;
    };
    logs: BrowserWebSocketDumpTestLogEntry[];
}

/**
 * End-to-end browser diagnostic for generate transport.
 *
 * It discovers the WebSocket connection id, sends an inline-image `/dump`
 * request, waits for the JSONTransport response, and returns checks that a UI
 * can display directly.
 */
export const browserWebSocketDumpTest = async (
    options: BrowserWebSocketDumpTestOptions = {},
): Promise<BrowserWebSocketDumpTestResult> => {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const logs: BrowserWebSocketDumpTestLogEntry[] = [];
    const log = (level: BrowserWebSocketDumpTestLogEntry['level'], event: string, data?: Record<string, unknown>) => {
        const entry: BrowserWebSocketDumpTestLogEntry = {
            time: new Date().toISOString(),
            level,
            event,
            data,
        };
        logs.push(entry);
        options.log?.(entry);
    };
    const endpoint = options.endpoint ?? 'http://localhost:8830/agents/!/generate';
    const timeoutMs = options.timeoutMs ?? 30_000;
    const model = options.model ?? 'gemini-3.1-flash-image-preview';
    const prompt = options.prompt ?? 'make a banner from this inline image';
    const imageBase64 = options.imageBase64 ?? 'abcdefghijklmnopqrstuvwxyz0123456789-browser-websocket-dump-test';
    const imageMimeType = options.imageMimeType ?? 'image/jpeg';
    const ws = options.ws ?? createDefaultWebSocket(options.wsUrl ?? 'wss://wss.eureka.codes/cht-d1?v2');
    const shouldClose = options.close ?? !options.ws;
    let network: BrowserWebSocketNetwork | undefined;
    let receiver: ReturnType<typeof createProxyTransportReceiver> | undefined;

    try {
        log('info', 'dumpTest.connectionId.start', { endpoint });
        const transportId = await waitWebSocketConnectionId(ws, {
            connectMessage: options.connectMessage ?? 'device.save',
            timeoutMs,
        });
        log('info', 'dumpTest.connectionId.ready', { transportId });

        network = new BrowserWebSocketNetwork(ws);
        await network.ready();
        receiver = createProxyTransportReceiver(network, { timeoutMs });

        const url = withQuery(endpoint, { transportId });
        const body = {
            model,
            prompt: {
                type: 'user',
                content: {
                    parts: [
                        {
                            inlineData: {
                                data: imageBase64,
                                mimeType: imageMimeType,
                            },
                        },
                        {
                            text: prompt,
                        },
                    ],
                },
            },
            system: '/dump',
            image: true,
            config: {
                responseModalities: ['IMAGE', 'TEXT'],
            },
        };
        let ack: unknown;
        log('info', 'dumpTest.fetch.start', { url, model, imageMimeType, imageBase64Length: imageBase64.length });
        const response = await receiver.wait(transportId, async () => {
            const fetcher = options.fetch ?? globalThis.fetch;
            const http = await callFetch(fetcher, url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(options.headers ?? {}),
                },
                body: JSON.stringify(body),
            });
            const text = await http.text();
            ack = tryParseJSON(text) ?? text;
            if (!http.ok) throw new Error(`HTTP ${http.status} ${http.statusText}`.trim() + (text ? ` - ${text}` : ''));
            log('info', 'dumpTest.fetch.ack', {
                status: http.status,
                transport: !!(ack as any)?.transport,
                transportId: (ack as any)?.transportId,
            });
            return ack;
        });

        const outputText = asGenAIOutputText(response);
        const dumped = outputText ? tryParseJSON(outputText) : undefined;
        const checks = {
            ackTransport: !!(ack as any)?.transport,
            hasOutputText: typeof outputText === 'string' && outputText.length > 0,
            dumpParsed: !!dumped,
            modelMatches: dumped?.model === model,
            inlineMimeTypeMatches: dumped?.contents?.parts?.[0]?.inlineData?.mimeType === imageMimeType,
            inlineDataTruncated: dumped?.contents?.parts?.[0]?.inlineData?.data === imageBase64.substring(0, 36),
            promptTextMatches: dumped?.contents?.parts?.[1]?.text === prompt,
            imageRequestMarked: dumped?.$param?.isImage === true,
            responseModalitiesKept:
                JSON.stringify(dumped?.$param?.config?.responseModalities) === JSON.stringify(['IMAGE', 'TEXT']),
        };
        const ok = Object.values(checks).every(Boolean);
        const finished = Date.now();
        const result = {
            ok,
            startedAt,
            finishedAt: new Date(finished).toISOString(),
            durationMs: finished - started,
            endpoint,
            transportId,
            request: { url, body },
            ack,
            response,
            dumped,
            checks,
            logs,
        };
        log(ok ? 'info' : 'error', 'dumpTest.done', { ok, checks });
        return result;
    } catch (error) {
        log('error', 'dumpTest.failed', { error: normalizeError(error) });
        throw error;
    } finally {
        receiver?.detach();
        network?.detach();
        if (shouldClose && typeof (ws as any).close === 'function') (ws as any).close();
    }
};

const createDefaultWebSocket = (url: string): WebSocketCompatible => {
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) throw new Error(`global WebSocket is not available - browserWebSocketDumpTest`);
    return new WebSocketCtor(url);
};

const withQuery = (endpoint: string, params: Record<string, string>): string => {
    const url = new URL(endpoint, 'http://localhost');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (/^https?:\/\//.test(endpoint)) return url.toString();
    return `${url.pathname}${url.search}${url.hash}`;
};

const callFetch = (fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetcher.call(globalThis, input, init);

const asGenAIOutputText = (response: object): string | undefined => {
    const content = (response as any)?.output?.content;
    if (typeof content === 'string') return content;
    const data = content && typeof content === 'object' ? (content as { data?: unknown }).data : undefined;
    return typeof data === 'string' ? data : undefined;
};

const tryParseJSON = (text: string) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const normalizeError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};
