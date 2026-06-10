/**
 * `genai/proxy.ts`
 * - HTTP-backed Gemini-compatible `AbstractGenAI` adapter.
 * - works in server and browser runtimes by relying only on the standard `fetch` API.
 *
 * @origin eureka-agents-api / src/lib/proxy/proxy.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import {
    ProxyGenAI,
    ProxyGenAIConfig,
    ProxyGenAIContents,
    ProxyGenAIGenerateContentParams,
    ProxyGenAIGenerateContentResponse,
    ProxyTransportReceiver,
} from './types';

/** options for wiring `HttpAbstractGenAI` to an agents generate endpoint */
export interface HttpAbstractGenAIOptions {
    /** extra HTTP request headers */
    headers?: Record<string, string>;
    /** fetch override for tests, browsers, or custom runtimes */
    fetch?: typeof fetch;
    /** optional WebSocket/API Gateway transport connection id */
    transportId?: string;
    /** receiver used when the final response is delivered through JSONTransport */
    transport?: ProxyTransportReceiver;
}

interface AgentGenerateBody {
    model: string;
    prompt?: string | { type?: string; content: ProxyGenAIContents };
    system?: string;
    image?: boolean;
    config?: ProxyGenAIConfig;
}

const asDataUrl = (data: string): { mimeType: string; data: string } | undefined => {
    const matched = data.match(/^data:(.*?);base64,(.*)$/);
    return matched ? { mimeType: matched[1] || 'image/png', data: matched[2] || '' } : undefined;
};

const onlyDefined = <T extends Record<string, unknown>>(data: T): T =>
    Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T;

const callFetch = (fetcher: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetcher.call(globalThis, input, init);

export const $gemini = {
    /**
     * Convert common agents `GenAIResponse` shapes back into Gemini-like
     * `models.generateContent()` response shape.
     */
    asGenerateContentResponse(data: any): ProxyGenAIGenerateContentResponse {
        const content = data?.output?.content;
        const dataUrl = content && typeof content === 'object' ? (content as { data?: string })?.data : undefined;
        const matched = typeof dataUrl === 'string' ? asDataUrl(dataUrl) : undefined;
        const text = typeof content === 'string' ? content : typeof dataUrl === 'string' && !matched ? dataUrl : '';
        const candidate =
            data?.candidate ??
            (matched
                ? {
                      content: {
                          parts: [
                              {
                                  inlineData: {
                                      mimeType: matched.mimeType,
                                      data: matched.data,
                                  },
                              },
                          ],
                      },
                  }
                : text
                ? {
                      content: {
                          parts: [{ text }],
                      },
                  }
                : undefined);

        return onlyDefined({
            text,
            candidates: candidate ? [candidate] : undefined,
            usageMetadata: data?.usage
                ? onlyDefined({
                      promptTokenCount: data.usage.promptToken,
                      thoughtsTokenCount: data.usage.completionToken,
                      totalTokenCount: data.usage.totalToken,
                  })
                : undefined,
        });
    },
};

/**
 * HTTP-backed Gemini-compatible `AbstractGenAI` adapter.
 *
 * It works in server and browser runtimes by relying only on the standard `fetch` API.
 * When `transportId` is configured, HTTP is used only to trigger generation and the
 * final response is collected from the configured transport receiver.
 */
export class HttpAbstractGenAI implements ProxyGenAI {
    /** captured raw generateContent params, useful in specs and diagnostics */
    public calls: ProxyGenAIGenerateContentParams[] = [];

    protected readonly fetcher: typeof fetch;
    protected readonly headers: Record<string, string>;
    protected readonly transportId?: string;
    protected readonly transport?: ProxyTransportReceiver;

    public constructor(protected readonly endpoint: string, options: HttpAbstractGenAIOptions = {}) {
        //! NOTE: property access (not bare `fetch`) so runtimes w/o global fetch fail at call time, not construction.
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.headers = options.headers ?? {};
        this.transportId = options.transportId;
        this.transport = options.transport;
    }

    public readonly models = {
        generateContent: async (
            params: ProxyGenAIGenerateContentParams,
        ): Promise<ProxyGenAIGenerateContentResponse> => {
            this.calls.push(params);

            const task = async () => {
                const response = await callFetch(this.fetcher, this.asEndpoint(), {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...this.headers,
                    },
                    body: JSON.stringify(this.asAgentGenerateBody(params)),
                });

                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new Error(
                        `HTTP ${response.status} ${response.statusText}`.trim() + (text ? ` - ${text}` : ''),
                    );
                }

                return response.json();
            };
            const data = this.transportId ? await this.waitTransport(task) : await task();
            return $gemini.asGenerateContentResponse(data);
        },
    };

    protected async waitTransport(task: () => Promise<unknown>): Promise<object> {
        if (!this.transport) throw new Error(`@transport is required when transportId is set - HttpAbstractGenAI`);
        return this.transport.wait(this.transportId!, task);
    }

    protected asEndpoint(): string {
        if (!this.transportId) return this.endpoint;
        const url = new URL(this.endpoint, 'http://localhost');
        url.searchParams.set('transportId', this.transportId);
        if (/^https?:\/\//.test(this.endpoint)) return url.toString();
        return `${url.pathname}${url.search}${url.hash}`;
    }

    protected asAgentGenerateBody(params: ProxyGenAIGenerateContentParams): AgentGenerateBody {
        const config = this.withoutSystemInstruction(params.config);
        const system = params.config?.systemInstruction;
        return {
            model: params.model,
            prompt: this.asPrompt(params.contents),
            system,
            image: this.isImageRequest(params),
            config,
        };
    }

    protected withoutSystemInstruction(config?: ProxyGenAIConfig): ProxyGenAIConfig | undefined {
        if (!config) return undefined;
        const { systemInstruction, ...rest } = config;
        return Object.keys(rest).length > 0 ? rest : undefined;
    }

    protected asPrompt(contents: ProxyGenAIContents): AgentGenerateBody['prompt'] {
        if (typeof contents === 'string') return contents;
        return { type: 'user', content: contents };
    }

    protected isImageRequest(params: ProxyGenAIGenerateContentParams): boolean | undefined {
        const modalities = params.config?.responseModalities ?? [];
        const hasImageModality = modalities.some(modality => `${modality}`.toUpperCase() === 'IMAGE');
        const hasInlineImage = this.hasInlineData(params.contents);
        const imageModel = params.model.includes('image') || params.model.includes('imagen');
        return hasImageModality || hasInlineImage || imageModel ? true : undefined;
    }

    private hasInlineData(contents: ProxyGenAIContents): boolean {
        const list = Array.isArray(contents) ? contents : [contents];
        return list.some(content => typeof content !== 'string' && content.parts?.some(part => !!part.inlineData));
    }
}
