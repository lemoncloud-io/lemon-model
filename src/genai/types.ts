/**
 * `genai/types.ts`
 * - Runtime-neutral Gemini-compatible GenAI proxy surface types for F/B usage.
 *
 * @origin eureka-agents-api / src/lib/proxy/types.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */

/** inline binary payload in Gemini-compatible content parts */
export interface ProxyGenAIInlineData {
    data: string;
    mimeType?: string;
}

/** text or inline-data part for a Gemini-compatible content block */
export interface ProxyGenAIPart {
    text?: string;
    inlineData?: ProxyGenAIInlineData;
}

/** Gemini-compatible content block */
export interface ProxyGenAIContent {
    role?: string;
    parts: ProxyGenAIPart[];
}

/** accepted `contents` shapes for proxy generateContent calls */
export type ProxyGenAIContents = string | ProxyGenAIContent | ProxyGenAIContent[];

/** image generation config subset used by samples/proxy */
export interface ProxyGenAIImageConfig {
    aspectRatio?: string;
    imageSize?: string;
}

/** generation config subset supported by `HttpAbstractGenAI` */
export interface ProxyGenAIConfig {
    systemInstruction?: string;
    responseMimeType?: string;
    responseSchema?: unknown;
    responseModalities?: unknown[];
    temperature?: number;
    topP?: number;
    imageConfig?: ProxyGenAIImageConfig;
}

/** Gemini-compatible generateContent params accepted by the proxy */
export interface ProxyGenAIGenerateContentParams {
    model: string;
    contents: ProxyGenAIContents;
    config?: ProxyGenAIConfig;
}

/** Gemini-compatible candidate response */
export interface ProxyGenAICandidate {
    content: {
        parts: ProxyGenAIPart[];
    };
}

/** Gemini-compatible generateContent response returned by the proxy */
export interface ProxyGenAIGenerateContentResponse {
    text?: string;
    candidates?: ProxyGenAICandidate[];
    usageMetadata?: {
        promptTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
    };
}

/** minimal GenAI interface implemented by `HttpAbstractGenAI` */
export interface ProxyGenAI {
    models: {
        generateContent(params: ProxyGenAIGenerateContentParams): Promise<ProxyGenAIGenerateContentResponse>;
    };
}

/** transport receiver used when HTTP only triggers work and the result arrives elsewhere */
export interface ProxyTransportReceiver<T extends object = object> {
    wait(transportId: string, task: () => Promise<unknown>): Promise<T>;
}
