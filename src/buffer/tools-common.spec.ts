/**
 * `buffer/tools-common.spec.ts`
 * - unit tests for the remaining probe helpers in tools/common.ts (clock, argv, files, redaction).
 *
 * @origin eureka-agents-api / tools/common.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'js-yaml';
import { expect2 } from '../cores/index.spec';
import { GenAIStreamEvent } from './stream';
import {
    artifactRef,
    createProbeClock,
    imageExtension,
    parseDataUrl,
    readArg,
    readBoolArg,
    readNumberArg,
    readProbeKind,
    redactBufferEvent,
    sanitizeFilePart,
    saveImageArtifact,
    summarizeBufferEvent,
    writeProbeResult,
} from '../../tools/common';

//* v5 B17: one temp root for every file the helpers write; removed in afterAll.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lemon-model-tools-common-'));
afterAll(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));

describe('tools/common createProbeClock', () => {
    afterEach(() => jest.restoreAllMocks());

    it('should capture the start time and measure elapsed time', () => {
        // pin Date.now() so the clock is deterministic.
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
        const clock = createProbeClock();
        expect2(() => clock.startedAt).toEqual(1_000);
        expect2(() => clock.startedAtIso).toEqual(new Date(1_000).toISOString());
        // explicit time argument.
        expect2(() => clock.elapsedMs(1_250)).toEqual(250);
        // never negative.
        expect2(() => clock.elapsedMs(500)).toEqual(0);
        // default argument reads Date.now() again.
        now.mockReturnValue(1_400);
        expect2(() => clock.elapsedMs()).toEqual(400);
    });
});

describe('tools/common argv readers', () => {
    const savedArgv = process.argv;
    // set the CLI flags after a fake `node script` prefix.
    const setArgs = (...args: string[]) => {
        process.argv = ['node', 'probe.ts', ...args];
    };
    beforeEach(() => setArgs());
    afterEach(() => {
        process.argv = savedArgv;
    });

    it('should read `--name value` with fallback', () => {
        expect2(() => readArg('model')).toEqual('');
        expect2(() => readArg('model', 'gpt')).toEqual('gpt');
        setArgs('--model', 'mini', '--out', 'a.yml');
        expect2(() => readArg('model')).toEqual('mini');
        expect2(() => readArg('out', 'x')).toEqual('a.yml');
        // flag at the end without a value → fallback.
        setArgs('--model');
        expect2(() => readArg('model', 'gpt')).toEqual('gpt');
        // `--name=value` is not a supported form: it does not match `--name`.
        setArgs('--model=mini');
        expect2(() => readArg('model', 'gpt')).toEqual('gpt');
    });

    it('should parse numbers with fallback and reject non-finite', () => {
        expect2(() => readNumberArg('count', 3)).toEqual(3);
        setArgs('--count', '12.5');
        expect2(() => readNumberArg('count', 3)).toEqual(12.5);
        setArgs('--count', '0');
        expect2(() => readNumberArg('count', 3)).toEqual(0);
        setArgs('--count', 'abc');
        expect2(() => readNumberArg('count', 3)).toEqual('--count must be a finite number');
        setArgs('--count', 'Infinity');
        expect2(() => readNumberArg('count', 3)).toEqual('--count must be a finite number');
    });

    it('should parse booleans in value and bare-flag forms', () => {
        expect2(() => readBoolArg('save')).toEqual(false);
        expect2(() => readBoolArg('save', true)).toEqual(true);
        // bare flag (last argument) → true.
        setArgs('--save');
        expect2(() => readBoolArg('save')).toEqual(true);
        setArgs('--save', '1');
        expect2(() => readBoolArg('save')).toEqual(true);
        setArgs('--save', 'true');
        expect2(() => readBoolArg('save')).toEqual(true);
        setArgs('--save', 'yes');
        expect2(() => readBoolArg('save')).toEqual(true);
        setArgs('--save', 'no');
        expect2(() => readBoolArg('save', true)).toEqual(false);
        // current behaviour: a bare flag followed by another flag reads that flag as its value → false.
        setArgs('--save', '--kind', 'text');
        expect2(() => readBoolArg('save')).toEqual(false);
    });

    it('should read the probe kind with `text` default', () => {
        expect2(() => readProbeKind()).toEqual('text');
        setArgs('--kind', 'json');
        expect2(() => readProbeKind()).toEqual('json');
        setArgs('--kind', 'image');
        expect2(() => readProbeKind()).toEqual('image');
        setArgs('--kind', 'audio');
        expect2(() => readProbeKind()).toEqual('--kind must be one of: text, json, image');
    });
});

describe('tools/common file-name and mime helpers', () => {
    it('should sanitize file parts', () => {
        expect2(() => sanitizeFilePart('gpt-4o mini/2026')).toEqual('gpt-4o-mini-2026');
        expect2(() => sanitizeFilePart('  a.b_c  ')).toEqual('a.b_c');
        expect2(() => sanitizeFilePart('@@x@@')).toEqual('x');
        expect2(() => sanitizeFilePart('')).toEqual('');
    });

    it('should parse data URLs with empty payload and raw base64', () => {
        expect2(() => parseDataUrl('data:image/webp;base64,')).toEqual({ mimeType: 'image/webp', base64: '' });
        expect2(() => parseDataUrl('QUJDRA==', 'image/jpeg')).toEqual({ mimeType: 'image/jpeg', base64: 'QUJDRA==' });
    });

    it('should map mime types to image extensions', () => {
        expect2(() => imageExtension('image/jpeg')).toEqual('jpg');
        expect2(() => imageExtension('IMAGE/JPG')).toEqual('jpg');
        expect2(() => imageExtension('image/webp')).toEqual('webp');
        expect2(() => imageExtension('image/png')).toEqual('png');
        expect2(() => imageExtension('image/gif')).toEqual('png');
        expect2(() => imageExtension('image/gif', 'gif')).toEqual('gif');
    });
});

describe('tools/common saveImageArtifact', () => {
    const bytes = Buffer.from('ABCD');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');

    it('should write the decoded data URL bytes and return the artifact', () => {
        const dir = path.join(TMP_ROOT, 'images');
        // whitespace inside the base64 payload is stripped before decoding.
        const value = 'data:image/jpeg;base64,QUJD\nRA==';
        const artifact = saveImageArtifact('mock-model', value, { dir, source: 'flush', index: 2 });
        expect2(() => artifact).toEqual({
            source: 'flush',
            index: 2,
            file: path.join(dir, `${hash}.jpg`),
            hash,
            mimeType: 'image/jpeg',
            extension: 'jpg',
            bytes: 4,
            base64Length: 8,
            dataUrlLength: 'data:image/jpeg;base64,QUJDRA=='.length,
        });
        expect2(() => fs.readFileSync(artifact.file).equals(bytes)).toEqual(true);
        expect2(() => artifactRef(artifact)).toEqual({
            file: artifact.file,
            hash,
            mimeType: 'image/jpeg',
            bytes: 4,
            base64Length: 8,
            dataUrlLength: artifact.dataUrlLength,
        });
    });

    it('should accept raw base64 with option mime/extension and keep an existing file', () => {
        const dir = path.join(TMP_ROOT, 'raw');
        const first = saveImageArtifact('mock-model', 'QUJDRA==', { dir, mimeType: 'image/webp', extension: 'bin' });
        expect2(() => first, 'file,mimeType,extension').toEqual({
            file: path.join(dir, `${hash}.bin`),
            mimeType: 'image/webp',
            extension: 'bin',
        });
        // content-addressed: an existing file is not rewritten.
        fs.writeFileSync(first.file, 'kept');
        const second = saveImageArtifact('mock-model', 'QUJDRA==', { dir, mimeType: 'image/webp', extension: 'bin' });
        expect2(() => second.file).toEqual(first.file);
        expect2(() => fs.readFileSync(second.file, 'utf8')).toEqual('kept');
    });

    it('should default to `sample/image` under the current folder', () => {
        const cwd = process.cwd();
        const work = fs.mkdtempSync(path.join(TMP_ROOT, 'cwd-'));
        // run in a temp cwd so the default relative folder never touches the repo.
        process.chdir(work);
        try {
            const artifact = saveImageArtifact('mock-model', 'QUJDRA==');
            expect2(() => artifact, 'file,mimeType,extension').toEqual({
                file: path.join('sample', 'image', `${hash}.png`),
                mimeType: 'image/png',
                extension: 'png',
            });
            expect2(() => fs.existsSync(path.join(work, artifact.file))).toEqual(true);
        } finally {
            process.chdir(cwd);
        }
    });
});

describe('tools/common writeProbeResult', () => {
    const data = { ok: true, model: 'mock', events: [{ index: 0, type: 'chunk' }] };

    it('should write YAML and create the folder', () => {
        const file = path.join(TMP_ROOT, 'out', 'nested', 'result.yml');
        writeProbeResult(file, data);
        expect2(() => YAML.load(fs.readFileSync(file, 'utf8'))).toEqual(data);
    });

    it('should write JSON when the file ends with .json', () => {
        const file = path.join(TMP_ROOT, 'out', 'result.json');
        writeProbeResult(file, data);
        const text = fs.readFileSync(file, 'utf8');
        expect2(() => text).toEqual(JSON.stringify(data, null, 2));
    });
});

describe('tools/common summarizeBufferEvent', () => {
    it('should summarize chunk and progress events without flush fields', () => {
        const chunk: GenAIStreamEvent = { type: 'chunk', index: 0, createdAt: 1_200, data: 'abc', chars: 3, bytes: 3 };
        // no startedAt → no elapsedMs.
        expect2(() => summarizeBufferEvent(chunk, 4)).toEqual({
            index: 4,
            type: 'chunk',
            eventIndex: 0,
            elapsedMs: undefined,
            dataLength: 3,
            count: undefined,
            chars: undefined,
            bytes: undefined,
            progress: undefined,
            meta: undefined,
        });
        // createdAt before startedAt is clamped to 0.
        expect2(() => summarizeBufferEvent(chunk, 4, 2_000).elapsedMs).toEqual(0);
        const progress: GenAIStreamEvent = {
            type: 'progress',
            progress: { loadedChars: 3, loadedBytes: 3, estimated: true },
        };
        // missing createdAt → no elapsedMs; progress is copied.
        expect2(() => summarizeBufferEvent(progress, 5, 1_000), 'elapsedMs,dataLength,progress').toEqual({
            elapsedMs: undefined,
            dataLength: undefined,
            progress: { loadedChars: 3, loadedBytes: 3, estimated: true },
        });
    });
});

describe('tools/common redactBufferEvent', () => {
    const data = 'data:image/png;base64,QUJDRA==';

    it('should keep non-image and non-payload events unchanged', () => {
        const text: GenAIStreamEvent = { type: 'chunk', data: 'hi', chars: 2, bytes: 2, meta: { kind: 'text' } };
        expect2(() => redactBufferEvent(text)).toBe(text);
        const noMeta: GenAIStreamEvent = { type: 'chunk', data, chars: data.length, bytes: data.length };
        expect2(() => redactBufferEvent(noMeta)).toBe(noMeta);
        const failed: GenAIStreamEvent = { type: 'error', error: 'boom', meta: { kind: 'image' } };
        expect2(() => redactBufferEvent(failed)).toBe(failed);
    });

    it('should redact an image chunk payload', () => {
        const event: GenAIStreamEvent = {
            type: 'chunk',
            index: 1,
            data,
            chars: data.length,
            bytes: data.length,
            meta: { kind: 'image' },
        };
        expect2(() => redactBufferEvent(event)).toEqual({
            type: 'chunk',
            index: 1,
            chars: data.length,
            bytes: data.length,
            meta: { kind: 'image' },
            data: { omitted: true, mimeType: 'image/png', dataUrlLength: data.length, base64Length: 8 },
        });
    });
});
