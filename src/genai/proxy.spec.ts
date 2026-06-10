/**
 * `proxy.spec.ts`
 * - tests for HTTP-backed Gemini-compatible proxy adapters.
 * - upstream connected these tests to a live `AgentAPIController`; here the server side is
 *   emulated by `MockAgentGenerateController` (`./mocks`), which reproduces the documented
 *   `/agents/!/generate` `/dump` + transport contract so the suite stays F/B-neutral.
 * - the generic WebSocket bridge basics are covered by `../socket/websocket.spec.ts`.
 *
 * @origin eureka-agents-api / src/lib/proxy/proxy.spec.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2, GETERR } from '../cores/index.spec';
//! the in-memory simulator is isolated from the root barrel — import it directly for tests.
import { createNetwork } from '../socket/socket';
import { createJSONTransport } from '../socket/transport';
import { WebSocketCompartible, WebSocketCompartibleEventMap } from '../socket/websocket';
import { browserWebSocketDumpTest } from './dump-test';
import { createAgentGenerateFetcher, MockAgentGenerateController, MockGenerateTransportSender } from './mocks';
import { HttpAbstractGenAI } from './proxy';
import { createProxyTransportReceiver } from './transport';
import { ProxyTransportReceiver } from './types';

const $ctx = { domain: 'localhost' } as any;

class FakeWebSocket implements WebSocketCompartible {
    public readonly CONNECTING = 0;
    public readonly OPEN = 1;
    public readonly CLOSING = 2;
    public readonly CLOSED = 3;
    public readyState = this.OPEN;
    public sent: string[] = [];
    public closeCalls = 0;
    private readonly listeners = new Map<string, Set<(event: any) => void>>();

    public send(data: string): void {
        this.sent.push(data);
    }

    public close(): void {
        this.closeCalls++;
        this.readyState = this.CLOSED;
    }

    public addEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
    ): void {
        let handlers = this.listeners.get(type);
        if (!handlers) {
            handlers = new Set();
            this.listeners.set(type, handlers);
        }
        handlers.add(handler);
    }

    public removeEventListener<K extends keyof WebSocketCompartibleEventMap>(
        type: K,
        handler: (event: WebSocketCompartibleEventMap[K]) => void,
    ): void {
        this.listeners.get(type)?.delete(handler);
    }

    public emit<K extends keyof WebSocketCompartibleEventMap>(type: K, event: WebSocketCompartibleEventMap[K]): void {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event);
    }
}

describe('genai/HttpAbstractGenAI', () => {
    it('should proxy generateContent through an HTTP endpoint', async () => {
        const requests: any[] = [];
        const fetcher = (async (url: string, init: any) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    output: {
                        content: JSON.stringify({ answer: 'from-http' }),
                    },
                    model: 'gemini-3-flash-preview',
                }),
            } as Response;
        }) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
            config: {
                systemInstruction: '/dump',
                responseMimeType: 'application/json',
                temperature: 0.7,
            },
        });

        expect2(() => ai.calls.length).toEqual(1);
        expect2(() => requests[0].url).toEqual('http://localhost:8830/agents/!/generate');
        expect2(() => requests[0].body).toEqual({
            model: 'gemini-3-flash-preview',
            prompt: 'hello',
            system: '/dump',
            config: {
                responseMimeType: 'application/json',
                temperature: 0.7,
            },
        });
        expect2(() => JSON.parse(response.text ?? '')).toEqual({ answer: 'from-http' });
        expect2(() => response.candidates?.[0]?.content.parts).toEqual([
            {
                text: JSON.stringify({ answer: 'from-http' }),
            },
        ]);
    });

    it('should call browser fetch with globalThis context', async () => {
        const fetcher = function (this: unknown, url: string, init: any) {
            if (this !== globalThis) throw new TypeError(`Illegal invocation`);
            return Promise.resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    output: {
                        content: JSON.stringify({ url, body: JSON.parse(init.body) }),
                    },
                }),
            } as Response);
        } as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
        });

        expect2(() => JSON.parse(response.text ?? ''), 'url,body').toEqual({
            url: 'http://localhost:8830/agents/!/generate',
            body: {
                model: 'gemini-3-flash-preview',
                prompt: 'hello',
            },
        });
    });

    it('should wait for transport response when transportId is configured', async () => {
        const requests: any[] = [];
        const fetcher = (async (url: string, init: any) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    transport: true,
                    transportId: 'transport-1',
                    sent: true,
                    packets: 2,
                }),
            } as Response;
        }) as typeof fetch;
        const receiverCalls: any[] = [];
        const transport: ProxyTransportReceiver = {
            wait: async (transportId: string, task: () => Promise<unknown>) => {
                receiverCalls.push({ transportId });
                const ack = await task();
                receiverCalls[0].ack = ack;
                return {
                    output: {
                        content: {
                            data: JSON.stringify({ answer: 'from-transport' }),
                        },
                    },
                    usage: {
                        promptToken: 1,
                        completionToken: 2,
                        totalToken: 3,
                    },
                };
            },
        };
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            fetch: fetcher,
            transportId: 'transport-1',
            transport,
        });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
        });

        expect2(() => requests[0].url).toEqual('http://localhost:8830/agents/!/generate?transportId=transport-1');
        expect2(() => receiverCalls).toEqual([
            {
                transportId: 'transport-1',
                ack: {
                    transport: true,
                    transportId: 'transport-1',
                    sent: true,
                    packets: 2,
                },
            },
        ]);
        expect2(() => JSON.parse(response.text ?? '')).toEqual({ answer: 'from-transport' });
        expect2(() => response.usageMetadata).toEqual({
            promptTokenCount: 1,
            thoughtsTokenCount: 2,
            totalTokenCount: 3,
        });
    });

    it('should require a transport receiver when transportId is configured', async () => {
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            transportId: 'transport-1',
        });

        const error = await ai.models
            .generateContent({
                model: 'gemini-3-flash-preview',
                contents: 'hello',
            })
            .catch(GETERR);

        expect2(() => error).toEqual('@transport is required when transportId is set - HttpAbstractGenAI');
    });

    it('should receive dump response from NetworkSupportable transport packets only', async () => {
        const network = createNetwork();
        const receiver = createProxyTransportReceiver(network, { timeoutMs: 1000 });
        const sendTransport: MockGenerateTransportSender = async (transportId, payload) => {
            network.send(JSON.stringify({ type: 'message', data: 'ignored by proxy receiver' }));
            const sender = createJSONTransport(network);
            sender.send(payload);
            sender.detach();
            return {
                result: true,
                packets: 1,
                connectionId: transportId,
                maxPacketBytes: 32768,
                largeValueBytes: 16384,
                chunkBytes: 31744,
            };
        };
        const controller = new MockAgentGenerateController({ sendTransport });
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            fetch: createAgentGenerateFetcher(controller, $ctx),
            transportId: 'transport-dump-1',
            transport: receiver,
        });

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: 'hello transport dump',
                config: {
                    systemInstruction: '/dump',
                    responseMimeType: 'application/json',
                },
            });
            const dumped = JSON.parse(response.text ?? '{}');

            expect2(() => dumped, 'model,contents,config').toEqual({
                model: 'gemini-3-flash-preview',
                contents: 'hello transport dump',
                config: {
                    responseMimeType: 'application/json',
                    systemInstruction: '/dump',
                },
            });
            expect2(() => dumped.$param, 'model,config').toEqual({
                model: 'gemini-3-flash-preview',
                config: {
                    responseMimeType: 'application/json',
                },
            });
        } finally {
            receiver.detach();
            network.close();
        }
    });

    it('should receive inline image dump response through NetworkSupportable transport', async () => {
        const network = createNetwork();
        const receiver = createProxyTransportReceiver(network, { timeoutMs: 1000 });
        const imageData = 'abcdefghijklmnopqrstuvwxyz0123456789-inline-image-dump';
        const sendTransport: MockGenerateTransportSender = async (transportId, payload) => {
            const sender = createJSONTransport(network);
            sender.send(payload);
            sender.detach();
            return {
                result: true,
                packets: 1,
                connectionId: transportId,
                maxPacketBytes: 32768,
                largeValueBytes: 16384,
                chunkBytes: 31744,
            };
        };
        const controller = new MockAgentGenerateController({ sendTransport });
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            fetch: createAgentGenerateFetcher(controller, $ctx),
            transportId: 'transport-inline-dump-1',
            transport: receiver,
        });

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.1-flash-image-preview',
                contents: {
                    parts: [
                        {
                            inlineData: {
                                data: imageData,
                                mimeType: 'image/jpeg',
                            },
                        },
                        {
                            text: 'make a banner from this inline image',
                        },
                    ],
                },
                config: {
                    systemInstruction: '/dump',
                    responseModalities: ['IMAGE', 'TEXT'],
                },
            });
            const dumped = JSON.parse(response.text ?? '{}');

            expect2(() => dumped.model).toEqual('gemini-3.1-flash-image-preview');
            expect2(() => dumped.contents.parts[0].inlineData).toEqual({
                data: imageData.substring(0, 36),
                mimeType: 'image/jpeg',
            });
            expect2(() => dumped.contents.parts[1]).toEqual({ text: 'make a banner from this inline image' });
            expect2(() => dumped.config, 'responseModalities,systemInstruction').toEqual({
                responseModalities: ['IMAGE', 'TEXT'],
                systemInstruction: '/dump',
            });
            expect2(() => dumped.$param, 'model,isImage,config').toEqual({
                model: 'gemini-3.1-flash-image-preview',
                isImage: true,
                config: {
                    responseModalities: ['IMAGE', 'TEXT'],
                },
            });
        } finally {
            receiver.detach();
            network.close();
        }
    });

    it('should connect HttpAbstractGenAI to doPostGenerate via dump', async () => {
        const $api = new MockAgentGenerateController();
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            fetch: createAgentGenerateFetcher($api, $ctx),
        });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
            config: {
                systemInstruction: '/dump',
                responseMimeType: 'application/json',
                temperature: 0.7,
                topP: 0.9,
            },
        });
        const dumped = JSON.parse(response.text ?? '{}');

        expect2(() => dumped, 'model,contents,config').toEqual({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
            config: {
                responseMimeType: 'application/json',
                temperature: 0.7,
                topP: 0.9,
                systemInstruction: '/dump',
            },
        });
        expect2(() => dumped.$param, 'model,config').toEqual({
            model: 'gemini-3-flash-preview',
            config: {
                responseMimeType: 'application/json',
                temperature: 0.7,
                topP: 0.9,
            },
        });
    });

    it('should connect structured image contents through doPostGenerate via dump', async () => {
        const $api = new MockAgentGenerateController();
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', {
            fetch: createAgentGenerateFetcher($api, $ctx),
        });
        const imageData = 'abcdefghijklmnopqrstuvwxyz0123456789-should-be-truncated';

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents: {
                parts: [
                    {
                        inlineData: {
                            data: imageData,
                            mimeType: 'image/jpeg',
                        },
                    },
                    {
                        text: 'make a banner',
                    },
                ],
            },
            config: {
                systemInstruction: '/dump',
                responseModalities: ['IMAGE', 'TEXT'],
            },
        });
        const dumped = JSON.parse(response.text ?? '{}');

        expect2(() => dumped, 'model').toEqual({ model: 'gemini-3.1-flash-image-preview' });
        expect2(() => dumped.contents.parts[0].inlineData).toEqual({
            data: imageData.substring(0, 36),
            mimeType: 'image/jpeg',
        });
        expect2(() => dumped.contents.parts[1]).toEqual({ text: 'make a banner' });
        expect2(() => dumped.$param, 'model,isImage,config').toEqual({
            model: 'gemini-3.1-flash-image-preview',
            isImage: true,
            config: {
                responseModalities: ['IMAGE', 'TEXT'],
            },
        });
    });

    it('should preserve inlineData contents when posting to HTTP endpoint', async () => {
        const requests: any[] = [];
        const fetcher = (async (url: string, init: any) => {
            requests.push({ url, init, body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    candidate: {
                        content: {
                            parts: [
                                {
                                    inlineData: {
                                        data: 'candidate-image',
                                        mimeType: 'image/png',
                                    },
                                },
                                {
                                    text: 'done',
                                },
                            ],
                        },
                    },
                }),
            } as Response;
        }) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });
        const contents = {
            parts: [
                {
                    inlineData: {
                        data: 'input-image',
                        mimeType: 'image/jpeg',
                    },
                },
                {
                    text: 'describe this image',
                },
            ],
        };

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents,
            config: {
                responseModalities: ['IMAGE', 'TEXT'],
            },
        });

        expect2(() => requests[0].body).toEqual({
            model: 'gemini-3.1-flash-image-preview',
            prompt: {
                type: 'user',
                content: contents,
            },
            image: true,
            config: {
                responseModalities: ['IMAGE', 'TEXT'],
            },
        });
        expect2(() => response.text).toEqual('');
        expect2(() => response.candidates?.[0]?.content.parts).toEqual([
            {
                inlineData: {
                    data: 'candidate-image',
                    mimeType: 'image/png',
                },
            },
            {
                text: 'done',
            },
        ]);
    });

    it('should preserve structured text contents when posting to HTTP endpoint', async () => {
        const requests: any[] = [];
        const fetcher = (async (_url: string, init: any) => {
            requests.push({ body: JSON.parse(init.body) });
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    output: {
                        content: 'ok',
                    },
                }),
            } as Response;
        }) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });
        const contents = {
            parts: [
                {
                    text: 'keep this as structured content',
                },
            ],
        };

        await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents,
            config: {
                systemInstruction: '/dump',
                imageConfig: {
                    aspectRatio: '16:9',
                    imageSize: '1K',
                },
            },
        });

        expect2(() => requests[0].body).toEqual({
            model: 'gemini-3.1-flash-image-preview',
            prompt: {
                type: 'user',
                content: contents,
            },
            system: '/dump',
            image: true,
            config: {
                imageConfig: {
                    aspectRatio: '16:9',
                    imageSize: '1K',
                },
            },
        });
    });

    it('should throw HTTP errors with response body text', async () => {
        const fetcher = (async () =>
            ({
                ok: false,
                status: 418,
                statusText: 'Teapot',
                text: async () => 'short and stout',
            } as Response)) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });

        const error = await ai.models
            .generateContent({
                model: 'gemini-3-flash-preview',
                contents: 'hello',
            })
            .catch(GETERR);

        expect2(() => error).toEqual('HTTP 418 Teapot - short and stout');
    });

    it('should convert HTTP image data url responses into inlineData parts', async () => {
        const fetcher = (async () =>
            ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    output: {
                        content: {
                            data: 'data:image/png;base64,http-image',
                        },
                    },
                }),
            } as Response)) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents: {
                parts: [{ text: 'make image' }],
            },
        });

        expect2(() => response.text).toEqual('');
        expect2(() => response.candidates?.[0]?.content.parts).toEqual([
            {
                inlineData: {
                    data: 'http-image',
                    mimeType: 'image/png',
                },
            },
        ]);
    });

    it('should map GenAIResponse usage like GeminiManager.byGenAIResponse', async () => {
        const fetcher = (async () =>
            ({
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => ({
                    output: {
                        content: 'usage text',
                    },
                    usage: {
                        promptToken: 2,
                        completionToken: 3,
                        totalToken: 5,
                    },
                }),
            } as Response)) as typeof fetch;
        const ai = new HttpAbstractGenAI('http://localhost:8830/agents/!/generate', { fetch: fetcher });

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: 'hello',
        });

        expect2(() => response).toEqual({
            text: 'usage text',
            candidates: [
                {
                    content: {
                        parts: [{ text: 'usage text' }],
                    },
                },
            ],
            usageMetadata: {
                promptTokenCount: 2,
                thoughtsTokenCount: 3,
                totalTokenCount: 5,
            },
        });
    });
});

describe('genai/browserWebSocketDumpTest', () => {
    it('should run browser dumpTest loop for inline image transport', async () => {
        const ws = new FakeWebSocket();
        ws.readyState = ws.CONNECTING;
        const logs: any[] = [];
        const sendTransport: MockGenerateTransportSender = async (transportId, payload) => {
            const sender = createJSONTransport({
                get readyState() {
                    return 'open' as const;
                },
                send: data => ws.emit('message', { data }),
                onMessage: () => () => undefined,
                onError: () => () => undefined,
                close: () => undefined,
            });
            sender.send(payload);
            sender.detach();
            return {
                result: true,
                packets: 1,
                connectionId: transportId,
                maxPacketBytes: 32768,
                largeValueBytes: 16384,
                chunkBytes: 31744,
            };
        };
        const controller = new MockAgentGenerateController({ sendTransport });
        const fetcher = createAgentGenerateFetcher(controller, $ctx);

        const task = browserWebSocketDumpTest({
            ws,
            endpoint: 'http://localhost:8830/agents/!/generate',
            fetch: function (this: unknown, ...args: Parameters<typeof fetch>) {
                if (this !== globalThis) throw new TypeError(`Illegal invocation`);
                return fetcher(...args);
            } as typeof fetch,
            timeoutMs: 1000,
            log: entry => logs.push(entry),
        });

        ws.readyState = ws.OPEN;
        ws.emit('open', {});
        await Promise.resolve();
        ws.emit('message', {
            data: JSON.stringify({
                type: 'device.saved',
                data: {
                    connId: 'browser-dump-connection-1',
                },
            }),
        });

        const result = await task;

        expect2(() => result.ok).toEqual(true);
        expect2(() => result.transportId).toEqual('browser-dump-connection-1');
        expect2(() => result.request.url).toEqual(
            'http://localhost:8830/agents/!/generate?transportId=browser-dump-connection-1',
        );
        expect2(() => result.checks).toEqual({
            ackTransport: true,
            hasOutputText: true,
            dumpParsed: true,
            modelMatches: true,
            inlineMimeTypeMatches: true,
            inlineDataTruncated: true,
            promptTextMatches: true,
            imageRequestMarked: true,
            responseModalitiesKept: true,
        });
        expect2(() => result.dumped?.$param?.isImage).toEqual(true);
        expect2(() => logs.some(log => log.event === 'dumpTest.done')).toEqual(true);
    });
});
