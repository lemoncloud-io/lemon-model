/**
 * Probe OpenAI Responses API stream event shapes.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind text --prompt "hello"
 *   OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind json --prompt "Return 3 colors"
 *   OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind image --prompt "A red cube"
 *   OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind image --imageSize 1k --aspectRatio 16:9
 *   OPENAI_API_KEY=... npx ts-node tools/openai-stream-probe.ts --kind image --model gpt-image-1
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
    redactBufferEvent,
    sanitizeFilePart,
    saveImageArtifact,
    summarizeBufferEvent,
    writeProbeResult,
} from './common';

type ProbeMode = 'direct' | 'manager' | 'both';
type OpenAIConstructor = new (options: { apiKey: string }) => any;

const loadOpenAI = (): OpenAIConstructor => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require('openai');
        return loaded.default ?? loaded;
    } catch {
        throw new Error(
            `The optional "openai" package is required for tools/openai-stream-probe.ts. ` +
                `Install it in this workspace before running the probe.`,
        );
    }
};

const readProbeMode = (): ProbeMode => {
    const mode = readArg('probeMode') || (readBoolArg('managerCheck', false) ? 'manager' : 'direct');
    if (mode === 'direct' || mode === 'manager' || mode === 'both') return mode;
    throw new Error(`--probeMode must be one of: direct, manager, both`);
};

const ensureDirectOnlyProbe = (mode: ProbeMode): void => {
    if (mode === 'direct') return;
    throw new Error(
        `OpenAI manager probe mode requires provider manager integration outside lemon-model. ` +
            `Run this probe with --probeMode direct.`,
    );
};

const buildTextConfig = (kind: ProbeKind): any | undefined => {
    if (kind !== 'json') return undefined;
    return {
        format: {
            type: 'json_schema',
            name: 'colors',
            strict: true,
            schema: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        name: { type: 'string' },
                        value: { type: 'string' },
                    },
                    required: ['name', 'value'],
                },
            },
        },
    };
};

const normalizeOpenAIImageSize = (imageSize: string, aspectRatio: string) => {
    const size = imageSize.trim().toLowerCase();
    const ratio = aspectRatio.trim();
    if (!size && !ratio) return undefined;
    if (size === 'auto') return 'auto';
    if (size === '1k' || size === '1k-square') return '1024x1024';
    if ((size === '1k' || !size) && ratio === '16:9') return '1536x1024';
    if ((size === '1k' || !size) && ratio === '9:16') return '1024x1536';
    if (size === 'landscape' || ratio === '3:2' || ratio === '16:9') return '1536x1024';
    if (size === 'portrait' || ratio === '2:3' || ratio === '9:16') return '1024x1536';
    if (/^\d+x\d+$/.test(size)) return size;
    return imageSize;
};

const normalizeOpenAIOutputFormat = (format: string): 'png' | 'webp' | 'jpeg' => {
    const normalized = format.trim().toLowerCase();
    if (normalized === 'png' || normalized === 'webp' || normalized === 'jpeg') return normalized;
    if (normalized === 'jpg') return 'jpeg';
    throw new Error(`--outputFormat must be one of: png, webp, jpeg`);
};

const readImageOptions = () => {
    const outputFormat = normalizeOpenAIOutputFormat(readArg('outputFormat') || readArg('format') || 'png');
    const imageSize = readArg('imageSize') || readArg('size');
    const aspectRatio = readArg('aspectRatio');
    return {
        outputFormat,
        imageSize,
        aspectRatio,
        openaiSize: normalizeOpenAIImageSize(imageSize, aspectRatio),
    };
};

const readBufferOptions = (
    kind: ProbeKind,
    model: string,
    image: ReturnType<typeof readImageOptions>,
): GenAIStreamBufferOptions => ({
    flushStrategy: (readArg('flushStrategy', 'hybrid') as GenAIStreamBufferOptions['flushStrategy']) ?? 'hybrid',
    bufferSize: readNumberArg('bufferSize', 2),
    bufferBytes: readNumberArg('bufferBytes', 16 * 1024),
    maxWaitMs: readNumberArg('maxWaitMs', 300),
    bufferMs: readNumberArg('bufferMs', 300),
    emitProgress: readBoolArg('emitProgress', true),
    meta: {
        provider: 'openai',
        model,
        kind,
        estimate: estimateGenAIStreamSize({
            kind,
            imageSize: image.imageSize || image.openaiSize || (kind === 'image' ? 'auto' : undefined),
            imageFormat: image.outputFormat,
        }),
    },
});

const defaultOutputFile = (model: string, kind: ProbeKind, imageModel?: string) => {
    if (kind !== 'image') return path.join('sample', 'openai', `stream-${sanitizeFilePart(model)}-${kind}.yml`);

    const image = readImageOptions();
    const parts = [
        'stream',
        sanitizeFilePart(model),
        imageModel ? sanitizeFilePart(imageModel) : undefined,
        kind,
        image.imageSize
            ? sanitizeFilePart(image.imageSize)
            : image.openaiSize
            ? sanitizeFilePart(image.openaiSize)
            : undefined,
        image.aspectRatio ? `ar-${sanitizeFilePart(image.aspectRatio)}` : undefined,
        image.outputFormat ? sanitizeFilePart(image.outputFormat) : undefined,
    ].filter(Boolean);
    return path.join('sample', 'openai', `${parts.join('-')}.yml`);
};

const summarizeEvent = (event: any, index: number, elapsedMs?: number) => ({
    index,
    type: event?.type,
    sequenceNumber: event?.sequence_number,
    elapsedMs,
    delta: event?.type === 'response.output_text.delta' ? event?.delta : undefined,
    deltaLength: event?.type === 'response.output_text.delta' ? event?.delta?.length : undefined,
    outputTextDoneLength: event?.type === 'response.output_text.done' ? event?.text?.length : undefined,
    outputTextDone: event?.type === 'response.output_text.done' ? event?.text : undefined,
    partialImageLength:
        event?.type === 'response.image_generation_call.partial_image' ? event?.partial_image_b64?.length : undefined,
    partialImageIndex:
        event?.type === 'response.image_generation_call.partial_image' ? event?.partial_image_index : undefined,
    status: event?.response?.status,
    model: event?.response?.model,
    outputCount: event?.response?.output?.length,
    usage: event?.response?.usage,
});

const summarizeImageArtifacts = (events: any[], finalResponse: any, model: string, outputFormat: string) => {
    const partialPreviews = events
        .filter(event => event?.type === 'response.image_generation_call.partial_image' && event.partial_image_b64)
        .map((event, index) => ({
            index,
            sequenceNumber: event.sequence_number,
            partialImageIndex: event.partial_image_index,
            artifact: saveImageArtifact(model, event.partial_image_b64, {
                mimeType: `image/${outputFormat}`,
                extension: outputFormat === 'jpeg' ? 'jpg' : outputFormat,
                source: event.type,
                index,
            }),
        }));
    const finalResults = (finalResponse?.output ?? [])
        .filter((item: any) => item?.type === 'image_generation_call' && item?.result)
        .map((item: any, index: number) => ({
            index,
            id: item.id,
            status: item.status,
            artifact: saveImageArtifact(model, item.result, {
                mimeType: `image/${outputFormat}`,
                extension: outputFormat === 'jpeg' ? 'jpg' : outputFormat,
                source: item.type,
                index,
            }),
        }));
    const lastPartial = partialPreviews.at(-1)?.artifact;
    const firstFinal = finalResults[0]?.artifact;
    return {
        partialPreviews,
        finalResults,
        partialVsFinal: {
            partialCount: partialPreviews.length,
            finalCount: finalResults.length,
            lastPartialBase64Length: lastPartial?.base64Length,
            firstFinalBase64Length: firstFinal?.base64Length,
            lastPartialHash: lastPartial?.hash,
            firstFinalHash: firstFinal?.hash,
            sameLength: lastPartial?.base64Length === firstFinal?.base64Length,
            sameHash: !!lastPartial?.hash && lastPartial.hash === firstFinal?.hash,
        },
    };
};

const saveOpenAIImageResultArtifact = (
    model: string,
    outputFormat: string,
    value: string,
    source: string,
    index?: number,
) =>
    saveImageArtifact(model, value, {
        mimeType: `image/${outputFormat}`,
        extension: outputFormat === 'jpeg' ? 'jpg' : outputFormat,
        source,
        index,
    });

const redactOpenAIImageItem = (item: any, model: string, outputFormat: string, index?: number) => {
    if (!item || item?.type !== 'image_generation_call' || !item.result) return item;
    const artifact = saveOpenAIImageResultArtifact(model, outputFormat, item.result, item.type, index);
    const { result: _result, ...rest } = item;
    return { ...rest, result_image: artifactRef(artifact) };
};

const redactOpenAIEvent = (event: any, model: string, outputFormat: string): any => {
    if (!event || typeof event !== 'object') return event;
    const redacted: any = { ...event };

    if (redacted.type === 'response.image_generation_call.partial_image' && redacted.partial_image_b64) {
        const artifact = saveOpenAIImageResultArtifact(
            model,
            outputFormat,
            redacted.partial_image_b64,
            redacted.type,
            redacted.partial_image_index,
        );
        delete redacted.partial_image_b64;
        redacted.partial_image = artifactRef(artifact);
    }

    if (redacted.item?.type === 'image_generation_call') {
        redacted.item = redactOpenAIImageItem(redacted.item, model, outputFormat, redacted.output_index);
    }

    if (redacted.response?.output) {
        redacted.response = redactOpenAIResponse(redacted.response, model, outputFormat);
    }

    return redacted;
};

const redactOpenAIResponse = (response: any, model: string, outputFormat: string): any => {
    if (!response || typeof response !== 'object') return response;
    return {
        ...response,
        output: (response.output ?? []).map((item: any, index: number) =>
            redactOpenAIImageItem(item, model, outputFormat, index),
        ),
    };
};

const extractOpenAIWrites = (
    event: any,
    fallbackKind: ProbeKind,
): Array<{ data: string; kind: ProbeKind; source: string }> => {
    const writes: Array<{ data: string; kind: ProbeKind; source: string }> = [];
    if (event?.type === 'response.output_text.delta' && event.delta) {
        writes.push({ data: event.delta, kind: fallbackKind === 'image' ? 'text' : fallbackKind, source: event.type });
    }
    if (event?.type === 'response.image_generation_call.partial_image' && event.partial_image_b64) {
        writes.push({
            data: `data:image/png;base64,${event.partial_image_b64}`,
            kind: 'image',
            source: event.type,
        });
    }
    return writes;
};

const main = async () => {
    const kind = readProbeKind();
    const apiKey = process.env.OPENAI_API_KEY || readArg('apiKey');
    if (!apiKey) throw new Error(`OPENAI_API_KEY or --apiKey is required`);

    const modelArg = readArg('model');
    const responseModel = kind === 'image' ? readArg('responseModel', 'gpt-5-mini') : modelArg || 'gpt-5-mini';
    const imageModel = kind === 'image' ? modelArg || readArg('imageModel') || 'gpt-image-1' : undefined;
    const image = readImageOptions();
    const probeMode = readProbeMode();
    ensureDirectOnlyProbe(probeMode);
    const prompt =
        readArg('prompt') ||
        (kind === 'json'
            ? 'Return 3 color names and hex values.'
            : kind === 'image'
            ? 'Generate a simple red cube on a white background.'
            : 'Say hello.');
    const out = readArg('out', defaultOutputFile(responseModel, kind, imageModel));
    const artifactModel = imageModel ?? responseModel;

    const OpenAI = loadOpenAI();
    const client = new OpenAI({ apiKey });
    const params: any = {
        model: responseModel,
        input: [{ role: 'user', content: prompt }],
        text: kind === 'image' ? undefined : buildTextConfig(kind),
        tools:
            kind === 'image'
                ? [
                      {
                          type: 'image_generation',
                          model: imageModel,
                          output_format: image.outputFormat,
                          size: image.openaiSize,
                          partial_images: 1,
                      } as any,
                  ]
                : undefined,
        tool_choice: kind === 'image' ? { type: 'image_generation' } : undefined,
        stream: true,
    };
    const events: any[] = [];
    const eventTimings: number[] = [];
    const bufferEvents: GenAIStreamEvent[] = [];
    const bufferOptions = readBufferOptions(kind, responseModel, image);
    const directRan = true;
    const probeClock = createProbeClock();
    let directClock = createProbeClock();
    let directStreamCreateElapsedMs: number | undefined;
    let directConsumeElapsedMs: number | undefined;
    const buffer = new GenAIStreamBuffer(event => {
        bufferEvents.push(event);
        console.log(
            `[buffer] ${JSON.stringify(
                summarizeBufferEvent(event, bufferEvents.length - 1, directClock.startedAt),
                null,
                2,
            )}`,
        );
    }, bufferOptions);

    let finalResponse: any = undefined;
    if (directRan) {
        const directCreateClock = createProbeClock();
        const stream = client.responses.stream(params);
        directStreamCreateElapsedMs = directCreateClock.elapsedMs();
        console.log(`[direct] stream created in ${directStreamCreateElapsedMs}ms`);
        directClock = createProbeClock();
        let index = 0;

        await buffer.start();
        for await (const event of stream) {
            const elapsedMs = directClock.elapsedMs();
            const summary = summarizeEvent(event, index++, elapsedMs);
            eventTimings.push(elapsedMs);
            events.push(event);
            console.log(`[raw] ${JSON.stringify(summary, null, 2)}`);
            const writes = extractOpenAIWrites(event, kind);
            for (const write of writes) {
                console.log(
                    `[write] ${JSON.stringify({
                        source: write.source,
                        kind: write.kind,
                        dataLength: write.data.length,
                    })}`,
                );
                await buffer.write(write.data, { kind: write.kind, source: write.source });
            }
        }
        await buffer.close();
        directConsumeElapsedMs = directClock.elapsedMs();

        finalResponse = await stream.finalResponse();
    }

    const result = {
        probe: {
            mode: probeMode,
            timing: {
                startedAt: probeClock.startedAt,
                startedAtIso: probeClock.startedAtIso,
                elapsedMs: probeClock.elapsedMs(),
            },
        },
        request: params,
        direct: {
            skipped: !directRan,
            method: 'OpenAI.responses.stream',
            timing: directRan
                ? {
                      streamCreateElapsedMs: directStreamCreateElapsedMs,
                      consumeElapsedMs: directConsumeElapsedMs,
                      startedAt: directClock.startedAt,
                      startedAtIso: directClock.startedAtIso,
                  }
                : undefined,
            responseCount: events.length,
            bufferEventCount: bufferEvents.length,
        },
        response:
            kind === 'image'
                ? events.map(event => redactOpenAIEvent(event, artifactModel, image.outputFormat))
                : events,
        finalResponse:
            kind === 'image' ? redactOpenAIResponse(finalResponse, artifactModel, image.outputFormat) : finalResponse,
        summary: events.map((event, index) => summarizeEvent(event, index, eventTimings[index])),
        image:
            kind === 'image'
                ? summarizeImageArtifacts(events, finalResponse, artifactModel, image.outputFormat)
                : undefined,
        buffer: {
            skipped: !directRan,
            options: bufferOptions,
            response: bufferEvents.map(redactBufferEvent),
            summary: bufferEvents.map((event, index) => summarizeBufferEvent(event, index, directClock.startedAt)),
            snapshot: buffer.snapshot(),
        },
        managerCheck: {
            skipped: true,
            reason: 'OpenAI manager check requires provider manager integration outside lemon-model.',
        },
    };
    writeProbeResult(out, result);
    console.log(`saved: ${out}`);
};

main().catch(err => {
    console.error(err);
    process.exit(1);
});
