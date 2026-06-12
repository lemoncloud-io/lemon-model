/**
 * `genai/mocks.ts`
 * - Test helpers for exercising `HttpAbstractGenAI` without a live agents API.
 * - `createAgentGenerateFetcher()` routes fetch calls into a controller-like object, and
 *   `MockAgentGenerateController` emulates the `/agents/!/generate` `/dump` + transport contract
 *   provided by the upstream agent generate controller.
 *
 * @origin eureka-agents-api / src/lib/proxy/mocks.ts (+ `/dump` contract distilled from `AgentAPIController` for F/B-neutral tests)
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */

/** minimal controller shape required by `createAgentGenerateFetcher()` */
export interface AgentGenerateControllerLike {
    doPostGenerate(id: string, param: unknown, body: unknown, ctx: unknown): Promise<unknown>;
}

/**
 * Create a `fetch` implementation that routes `/agents/:id/generate` calls
 * directly into a controller instance.
 */
export const createAgentGenerateFetcher = (api: AgentGenerateControllerLike, ctx: unknown): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
        const href = typeof url === 'string' || url instanceof URL ? `${url}` : url.url;
        const parsed = new URL(href, 'http://localhost');
        const matched = parsed.pathname.match(/^\/agents\/(.+)\/generate$/);
        if (!matched) {
            return {
                ok: false,
                status: 404,
                statusText: 'Not Found',
                text: async () => `unsupported endpoint: ${parsed.pathname}`,
            } as Response;
        }

        const body = init?.body ? JSON.parse(`${init.body}`) : {};
        try {
            const data = await api.doPostGenerate(
                decodeURIComponent(matched[1]),
                Object.fromEntries(parsed.searchParams.entries()),
                body,
                ctx,
            );
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                json: async () => data,
                text: async () => JSON.stringify(data),
            } as Response;
        } catch (e) {
            const text = e instanceof Error ? e.message : `${e}`;
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: async () => text,
            } as Response;
        }
    }) as typeof fetch;

/** ack subset returned by a transport sender (see `ApiGatewayTransportSendResult` upstream) */
export interface MockGenerateTransportResult {
    result?: boolean;
    packets?: number;
    [key: string]: unknown;
}

/** hook used by `MockAgentGenerateController` to deliver the final payload over a transport */
export type MockGenerateTransportSender = (
    transportId: string,
    payload: Record<string, any>,
) => Promise<MockGenerateTransportResult>;

/** options for `MockAgentGenerateController` */
export interface MockAgentGenerateControllerOptions {
    /** sender invoked when the generate request carries a `transportId` query parameter */
    sendTransport?: MockGenerateTransportSender;
}

const onlyDefined = <T extends Record<string, unknown>>(data: T): T =>
    Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T;

/** truncate inlineData payloads to 36 chars like the upstream `/dump` echo */
const truncateInlineData = (contents: any): any => {
    if (!contents || typeof contents !== 'object') return contents;
    if (Array.isArray(contents)) return contents.map(truncateInlineData);
    const parts = Array.isArray(contents.parts)
        ? contents.parts.map((part: any) =>
              part?.inlineData?.data
                  ? { ...part, inlineData: { ...part.inlineData, data: `${part.inlineData.data}`.substring(0, 36) } }
                  : part,
          )
        : undefined;
    return parts ? { ...contents, parts } : contents;
};

/** build the `/dump` echo payload from an agents generate request body */
export const asDumpedGenerateRequest = (body: any): Record<string, any> => {
    const prompt = body?.prompt;
    const contents = typeof prompt === 'string' ? prompt : truncateInlineData(prompt?.content);
    const config0 = onlyDefined({ ...(body?.config ?? {}), systemInstruction: body?.system });
    const config = Object.keys(config0).length > 0 ? config0 : undefined;
    const $param = onlyDefined({
        model: body?.model,
        isImage: body?.image === true ? true : undefined,
        config: body?.config,
    });
    return onlyDefined({ model: body?.model, contents, config, $param });
};

/**
 * In-memory stand-in for `AgentAPIController.doPostGenerate()` covering the `/dump` contract:
 * - without `transportId`, it answers the dumped request as `output.content` JSON.
 * - with `transportId`, it delivers the payload via `sendTransport()` and answers a transport ack.
 */
export class MockAgentGenerateController implements AgentGenerateControllerLike {
    public constructor(private readonly options: MockAgentGenerateControllerOptions = {}) {}

    public async doPostGenerate(id: string, param: any, body: any, _ctx: unknown): Promise<unknown> {
        if (!id) throw new Error(`@id (string) is required - mocks.doPostGenerate`);
        const model = body?.model;
        const dumped = asDumpedGenerateRequest(body);
        const $final = { output: { content: JSON.stringify(dumped) }, model };

        const transportId = typeof param?.transportId === 'string' ? param.transportId : '';
        if (!transportId) return $final;

        const sender = this.options.sendTransport;
        if (!sender)
            throw new Error(`.sendTransport is required when transportId is set - MockAgentGenerateController`);
        const transport = await sender(transportId, $final);
        return onlyDefined({
            transport: true,
            transportId,
            sent: transport.result ?? true,
            packets: transport.packets ?? 1,
            model,
        });
    }
}
