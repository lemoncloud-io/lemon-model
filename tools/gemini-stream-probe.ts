/**
 * Probe GoogleGenAI generateContentStream chunk shapes.
 *
 * Usage:
 *   GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind text --prompt "hello"
 *   GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind json --prompt "Return 3 colors"
 *   GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind image --model gemini-3-pro-image-preview --prompt "A red cube"
 *   GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind image --model gemini-2.5-flash-image --prompt "A red cube"
 *   GEMINI_API_KEY=... npx ts-node tools/gemini-stream-probe.ts --kind image --imageSize 2K --aspectRatio 16:9
 *
 * Buffer probe options:
 *   --bufferSize 2 --flushStrategy hybrid --emitProgress true --maxWaitMs 300
 *
 * Notes:
 *   lemon-model owns provider-neutral buffer primitives only. Provider manager
 *   checks live outside this package, so this probe supports direct SDK stream
 *   inspection only.
 */
import * as path from 'path';
import {
    estimateGenAIStreamSize,
    GenAIStreamBuffer,
    GenAIStreamBufferOptions,
    GenAIStreamEvent,
} from '../src/buffer/stream';
import {
    artifactRef,
    createProbeClock,
    ProbeKind,
    readArg,
    readBoolArg,
    readNumberArg,
    readProbeKind,
    sanitizeFilePart,
    saveImageArtifact,
    summarizeBufferEvent,
    writeProbeResult,
} from './common';

type ProbeMode = 'direct' | 'manager' | 'both';

const loadGoogleGenAI = (): { GoogleGenAI: new (options: { apiKey: string }) => any } => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require('@google/genai');
        return { GoogleGenAI: loaded.GoogleGenAI };
    } catch {
        throw new Error(
            `The optional "@google/genai" package is required for tools/gemini-stream-probe.ts. ` +
                `Install it in this workspace before running the probe.`,
        );
    }
};

const readProbeMode = (): ProbeMode => {
    const mode = readArg('probeMode') || (readBoolArg('managerCheck', false) ? 'manager' : 'direct');
    if (mode === 'direct' || mode === 'manager' || mode === 'both') return mode;
    throw new Error(`--probeMode must be one of: direct, manager, both`);
};

const shouldIncludeThoughtSignature = () => readBoolArg('includeThoughtSignature', false);

const ensureDirectOnlyProbe = (mode: ProbeMode): void => {
    if (mode === 'direct') return;
    throw new Error(
        `Gemini manager probe mode requires provider manager integration outside lemon-model. ` +
            `Run this probe with --probeMode direct.`,
    );
};

const readImageOptions = () => ({
    aspectRatio: readArg('aspectRatio'),
    imageSize: readArg('imageSize') || readArg('size'),
    outputFormat: readArg('outputFormat') || readArg('format'),
});

const readBufferOptions = (kind: ProbeKind): GenAIStreamBufferOptions => {
    const image = readImageOptions();
    return {
        flushStrategy: (readArg('flushStrategy', 'hybrid') as GenAIStreamBufferOptions['flushStrategy']) ?? 'hybrid',
        bufferSize: readNumberArg('bufferSize', 2),
        bufferBytes: readNumberArg('bufferBytes', 16 * 1024),
        maxWaitMs: readNumberArg('maxWaitMs', 300),
        bufferMs: readNumberArg('bufferMs', 300),
        emitProgress: readBoolArg('emitProgress', true),
        meta: {
            provider: 'gemini',
            kind,
            estimate: estimateGenAIStreamSize({
                kind,
                imageSize: image.imageSize,
                imageFormat: image.outputFormat,
            }),
        },
    };
};

const defaultOutputFile = (model: string, kind: ProbeKind) => {
    if (kind !== 'image') return path.join('sample', 'gemini', `stream-${sanitizeFilePart(model)}-${kind}.yml`);

    const image = readImageOptions();
    const parts = [
        'stream',
        sanitizeFilePart(model),
        kind,
        image.imageSize ? sanitizeFilePart(image.imageSize) : undefined,
        image.aspectRatio ? `ar-${sanitizeFilePart(image.aspectRatio)}` : undefined,
        image.outputFormat ? sanitizeFilePart(image.outputFormat) : undefined,
    ].filter(Boolean);
    return path.join('sample', 'gemini', `${parts.join('-')}.yml`);
};

const buildConfig = (kind: ProbeKind): any | undefined => {
    if (kind === 'json') {
        return {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        value: { type: 'string' },
                    },
                    required: ['name', 'value'],
                },
            } as any,
        };
    }
    if (kind === 'image') {
        const image = readImageOptions();
        return {
            responseModalities: ['IMAGE'],
            imageConfig:
                image.aspectRatio || image.imageSize || image.outputFormat
                    ? ({
                          aspectRatio: image.aspectRatio || undefined,
                          imageSize: image.imageSize || undefined,
                          outputMimeType: image.outputFormat ? `image/${image.outputFormat}` : undefined,
                      } as any)
                    : undefined,
        };
    }
    return undefined;
};

const getGeminiParts = (chunk: any): any[] =>
    (chunk?.candidates ?? []).flatMap((candidate: any) => candidate?.content?.parts ?? []);

const getGeminiText = (chunk: any): string =>
    getGeminiParts(chunk)
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');

const summarizeChunk = (chunk: any, index: number, elapsedMs?: number) => ({
    index,
    elapsedMs,
    text: getGeminiText(chunk) || undefined,
    candidateCount: chunk?.candidates?.length,
    finishReason: chunk?.candidates?.[0]?.finishReason,
    parts: getGeminiParts(chunk).map((part: any) => ({
        hasText: typeof part?.text === 'string',
        textLength: part?.text?.length,
        inlineMimeType: part?.inlineData?.mimeType,
        inlineDataLength: part?.inlineData?.data?.length,
    })),
    usageMetadata: chunk?.usageMetadata,
    modelVersion: chunk?.modelVersion,
    responseId: chunk?.responseId,
});

const summarizeImageArtifacts = (chunks: any[], model: string) => {
    const images = chunks.flatMap((chunk, chunkIndex) => {
        const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
        return parts
            .map((part: any, partIndex: number) => ({ part, partIndex }))
            .filter(({ part }: any) => part?.inlineData?.data)
            .map(({ part, partIndex }: any) => ({
                chunkIndex,
                partIndex,
                artifact: saveImageArtifact(model, part.inlineData.data, {
                    mimeType: part.inlineData.mimeType ?? 'image/png',
                    source: 'inlineData',
                    index: chunkIndex,
                }),
            }));
    });
    return {
        images,
        count: images.length,
        hashes: images.map(image => image.artifact.hash),
    };
};

const saveGeminiImageArtifact = (model: string, value: string, source: string, index?: number, mimeType?: string) =>
    saveImageArtifact(model, value, {
        mimeType: mimeType ?? 'image/png',
        source,
        index,
    });

const stripThoughtSignature = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stripThoughtSignature);

    const result: any = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === 'thoughtSignature') continue;
        result[key] = stripThoughtSignature(child);
    }
    return result;
};

const redactGeminiChunk = (chunk: any, model: string, includeThoughtSignature: boolean): any => {
    if (!chunk || typeof chunk !== 'object') return chunk;
    const redacted = {
        ...chunk,
        candidates: chunk.candidates?.map((candidate: any, candidateIndex: number) => ({
            ...candidate,
            content: {
                ...candidate.content,
                parts: candidate.content?.parts?.map((part: any, partIndex: number) => {
                    if (!part?.inlineData?.data) return part;
                    const artifact = saveImageArtifact(model, part.inlineData.data, {
                        mimeType: part.inlineData.mimeType ?? 'image/png',
                        source: 'inlineData',
                        index: partIndex,
                    });
                    return {
                        ...part,
                        inlineData: {
                            mimeType: part.inlineData.mimeType,
                            artifact: artifactRef(artifact),
                            candidateIndex,
                            partIndex,
                        },
                    };
                }),
            },
        })),
    };
    return includeThoughtSignature ? redacted : stripThoughtSignature(redacted);
};

const redactGeminiBufferEvent = (event: GenAIStreamEvent, model: string): GenAIStreamEvent | any => {
    if ((event.type !== 'chunk' && event.type !== 'flush') || event.meta?.kind !== 'image') return event;
    const redactData = (data: string, source: string, index?: number) => {
        if (!data.startsWith('data:image/')) {
            return {
                omitted: true,
                dataLength: data.length,
            };
        }
        const artifact = saveGeminiImageArtifact(model, data, source, index);
        return {
            omitted: true,
            artifact: artifactRef(artifact),
        };
    };

    if (event.type === 'chunk') {
        const { data: _data, ...rest } = event;
        return { ...rest, data: redactData(event.data, 'buffer.chunk', event.index) };
    }

    const { data: _data, chunks, ...rest } = event;
    return {
        ...rest,
        data:
            chunks.length === 1
                ? redactData(event.data, 'buffer.flush', event.index)
                : {
                      omitted: true,
                      dataLength: event.data.length,
                      chunkCount: chunks.length,
                  },
        chunks: chunks.map(chunk => {
            const { data: _chunkData, ...chunkRest } = chunk;
            return { ...chunkRest, data: redactData(chunk.data, 'buffer.flush.chunk', chunk.index) };
        }),
    };
};

const extractGeminiWrites = (
    chunk: any,
    fallbackKind: ProbeKind,
): Array<{ data: string; kind: ProbeKind; source: string }> => {
    const writes: Array<{ data: string; kind: ProbeKind; source: string }> = [];
    const parts = getGeminiParts(chunk);
    for (const part of parts) {
        if (typeof part?.text === 'string' && part.text.length > 0) {
            writes.push({
                data: part.text,
                kind: fallbackKind === 'image' ? 'text' : fallbackKind,
                source: 'part.text',
            });
        }
        const inlineData = part?.inlineData;
        if (inlineData?.data) {
            const mimeType = inlineData.mimeType ?? 'image/png';
            writes.push({ data: `data:${mimeType};base64,${inlineData.data}`, kind: 'image', source: 'inlineData' });
        }
    }
    return writes;
};

const main = async () => {
    const kind = readProbeKind();
    const apiKey = process.env.GEMINI_API_KEY || readArg('apiKey');
    if (!apiKey) throw new Error(`GEMINI_API_KEY or --apiKey is required`);

    const model = readArg('model') || (kind === 'image' ? 'gemini-3-pro-image-preview' : 'gemini-2.5-flash');
    const prompt = readArg('prompt') || (kind === 'json' ? 'Return 3 color names and hex values.' : 'Say hello.');
    const probeMode = readProbeMode();
    ensureDirectOnlyProbe(probeMode);
    const includeThoughtSignature = shouldIncludeThoughtSignature();
    const out = readArg('out', defaultOutputFile(model, kind));

    const { GoogleGenAI } = loadGoogleGenAI();
    const ai = new GoogleGenAI({ apiKey });
    const params: any = {
        model,
        contents: prompt,
        config: buildConfig(kind),
    };
    const directRan = true;
    const probeClock = createProbeClock();
    const chunks: any[] = [];
    const chunkTimings: number[] = [];
    const bufferEvents: GenAIStreamEvent[] = [];
    const bufferOptions = readBufferOptions(kind);
    let directClock = createProbeClock();
    let directStreamCreateElapsedMs: number | undefined;
    let directConsumeElapsedMs: number | undefined;
    const buffer = new GenAIStreamBuffer(
        event => {
            bufferEvents.push(event);
            console.log(
                `[buffer] ${JSON.stringify(
                    summarizeBufferEvent(event, bufferEvents.length - 1, directClock.startedAt),
                    null,
                    2,
                )}`,
            );
        },
        {
            ...bufferOptions,
            meta: {
                ...bufferOptions.meta,
                model,
            },
        },
    );

    if (directRan) {
        const directCreateClock = createProbeClock();
        const stream = await ai.models.generateContentStream(params);
        directStreamCreateElapsedMs = directCreateClock.elapsedMs();
        console.log(`[direct] stream created in ${directStreamCreateElapsedMs}ms`);
        directClock = createProbeClock();
        let index = 0;

        await buffer.start();
        for await (const chunk of stream) {
            const elapsedMs = directClock.elapsedMs();
            const summary = summarizeChunk(chunk, index++, elapsedMs);
            chunkTimings.push(elapsedMs);
            chunks.push(chunk);
            console.log(`[raw] ${JSON.stringify(summary, null, 2)}`);
            const writes = extractGeminiWrites(chunk, kind);
            for (const write of writes) {
                console.log(
                    `[write] ${JSON.stringify({
                        source: write.source,
                        kind: write.kind,
                        dataLength: write.data.length,
                    })}`,
                );
                await buffer.write(write.data, { kind: write.kind });
            }
        }
        await buffer.close();
        directConsumeElapsedMs = directClock.elapsedMs();
    }

    const result = {
        probe: {
            mode: probeMode,
            includeThoughtSignature,
            timing: {
                startedAt: probeClock.startedAt,
                startedAtIso: probeClock.startedAtIso,
                elapsedMs: probeClock.elapsedMs(),
            },
        },
        request: params,
        direct: {
            skipped: !directRan,
            method: 'GoogleGenAI.models.generateContentStream',
            timing: directRan
                ? {
                      streamCreateElapsedMs: directStreamCreateElapsedMs,
                      consumeElapsedMs: directConsumeElapsedMs,
                      startedAt: directClock.startedAt,
                      startedAtIso: directClock.startedAtIso,
                  }
                : undefined,
            responseCount: chunks.length,
            bufferEventCount: bufferEvents.length,
        },
        response:
            kind === 'image'
                ? chunks.map(chunk => redactGeminiChunk(chunk, model, includeThoughtSignature))
                : includeThoughtSignature
                ? chunks
                : stripThoughtSignature(chunks),
        summary: chunks.map((chunk, index) => summarizeChunk(chunk, index, chunkTimings[index])),
        image: kind === 'image' ? summarizeImageArtifacts(chunks, model) : undefined,
        buffer: {
            skipped: !directRan,
            options: {
                ...bufferOptions,
                meta: { ...bufferOptions.meta, model },
            },
            response: bufferEvents.map(event => redactGeminiBufferEvent(event, model)),
            summary: bufferEvents.map((event, index) => summarizeBufferEvent(event, index, directClock.startedAt)),
            snapshot: buffer.snapshot(),
        },
        managerCheck: {
            skipped: true,
            reason: 'Gemini manager check requires provider manager integration outside lemon-model.',
        },
    };
    writeProbeResult(out, result);
    console.log(`saved: ${out}`);
};

main().catch(err => {
    console.error(err);
    process.exit(1);
});
