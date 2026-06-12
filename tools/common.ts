import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'js-yaml';
import { GenAIStreamEvent } from '../src/buffer/stream';

export type ProbeKind = 'text' | 'json' | 'image';

export interface ImageArtifactOptions {
    mimeType?: string;
    extension?: string;
    source?: string;
    index?: number;
}

export interface ProbeClock {
    startedAt: number;
    startedAtIso: string;
    elapsedMs: (time?: number) => number;
}

export const createProbeClock = (): ProbeClock => {
    const startedAt = Date.now();
    return {
        startedAt,
        startedAtIso: new Date(startedAt).toISOString(),
        elapsedMs: (time = Date.now()) => Math.max(0, time - startedAt),
    };
};

export const readArg = (name: string, fallback = '') => {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0) return fallback;
    return process.argv[index + 1] ?? fallback;
};

export const readNumberArg = (name: string, fallback: number) => {
    const value = readArg(name);
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a finite number`);
    return parsed;
};

export const readBoolArg = (name: string, fallback = false) => {
    const value = readArg(name);
    if (!value) return process.argv.includes(`--${name}`) ? true : fallback;
    return value === '1' || value === 'true' || value === 'yes';
};

export const readProbeKind = (): ProbeKind => {
    const kind = readArg('kind', 'text');
    if (kind === 'text' || kind === 'json' || kind === 'image') return kind;
    throw new Error(`--kind must be one of: text, json, image`);
};

export const sanitizeFilePart = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export const parseDataUrl = (value: string, fallbackMimeType = 'image/png') => {
    const match = value.match(/^data:([^;]+);base64,(.*)$/s);
    if (!match) return { mimeType: fallbackMimeType, base64: value };
    return { mimeType: match[1] || fallbackMimeType, base64: match[2] || '' };
};

export const imageExtension = (mimeType: string, fallback = 'png') => {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
    if (normalized.includes('webp')) return 'webp';
    if (normalized.includes('png')) return 'png';
    return fallback;
};

export const saveImageArtifact = (model: string, value: string, options?: ImageArtifactOptions) => {
    const parsed = parseDataUrl(value, options?.mimeType ?? 'image/png');
    const base64 = parsed.base64.replace(/\s/g, '');
    const bytes = Buffer.from(base64, 'base64');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const ext = options?.extension ?? imageExtension(parsed.mimeType);
    const fileName = `${hash}.${ext}`;
    const file = path.join('sample', 'image', fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return {
        source: options?.source,
        index: options?.index,
        file,
        hash,
        mimeType: parsed.mimeType,
        extension: ext,
        bytes: bytes.length,
        base64Length: base64.length,
        dataUrlLength: `data:${parsed.mimeType};base64,${base64}`.length,
    };
};

export const artifactRef = (artifact: ReturnType<typeof saveImageArtifact>) => ({
    file: artifact.file,
    hash: artifact.hash,
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
    base64Length: artifact.base64Length,
    dataUrlLength: artifact.dataUrlLength,
});

export const writeProbeResult = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = file.endsWith('.json')
        ? JSON.stringify(data, null, 2)
        : YAML.dump(data, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(file, text);
};

export const summarizeBufferEvent = (event: GenAIStreamEvent, index: number, startedAt?: number) => ({
    index,
    type: event.type,
    eventIndex: event.index,
    elapsedMs: startedAt && event.createdAt ? Math.max(0, event.createdAt - startedAt) : undefined,
    dataLength: event.type === 'chunk' || event.type === 'flush' ? event.data?.length : undefined,
    count: event.type === 'flush' ? event.count : undefined,
    chars: event.type === 'flush' ? event.chars : undefined,
    bytes: event.type === 'flush' ? event.bytes : undefined,
    progress: 'progress' in event ? event.progress : undefined,
    meta: event.meta,
});

export const redactBufferEvent = (event: GenAIStreamEvent): GenAIStreamEvent | any => {
    if ((event.type !== 'chunk' && event.type !== 'flush') || event.meta?.kind !== 'image') return event;
    const redactData = (data: string) => {
        const parsed = parseDataUrl(data);
        return {
            omitted: true,
            mimeType: parsed.mimeType,
            dataUrlLength: data.length,
            base64Length: parsed.base64.length,
        };
    };
    if (event.type === 'chunk') {
        const { data: _data, ...rest } = event;
        return { ...rest, data: redactData(event.data) };
    }
    const { data: _data, chunks, ...rest } = event;
    return {
        ...rest,
        data: redactData(event.data),
        chunks: chunks.map(chunk => {
            const { data: _chunkData, ...chunkRest } = chunk;
            return { ...chunkRest, data: redactData(chunk.data) };
        }),
    };
};
