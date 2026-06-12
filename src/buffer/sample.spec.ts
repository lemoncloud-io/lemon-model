/**
 * `buffer/sample.spec.ts`
 * - copied stream probe fixture integrity tests.
 *
 * @origin eureka-agents-api / sample/{openai,gemini,image}
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import * as fs from 'fs';
import * as path from 'path';
import { expect2 } from '../cores/index.spec';

const repoRoot = path.resolve(__dirname, '../..');
const sampleRoot = path.join(repoRoot, 'sample');

const listFiles = (dir: string, pattern: RegExp): string[] =>
    fs
        .readdirSync(path.join(sampleRoot, dir))
        .filter(file => pattern.test(file))
        .map(file => path.join('sample', dir, file))
        .sort();

const read = (file: string): string => fs.readFileSync(path.join(repoRoot, file), 'utf8');

describe('buffer stream probe samples', () => {
    it('should include copied OpenAI and Gemini stream probe fixtures', () => {
        const openai = listFiles('openai', /^stream-.*\.yml$/);
        const gemini = listFiles('gemini', /^stream-.*\.yml$/);
        const geminiNative = listFiles('gemini', /^generate-content-stream-.*\.json$/);

        expect2(() => openai.map(file => path.basename(file))).toEqual([
            'stream-gpt-5-mini-gpt-image-2-image-png.yml',
            'stream-gpt-5-mini-image.yml',
            'stream-gpt-5-mini-json.yml',
            'stream-gpt-5-mini-text.yml',
        ]);
        expect2(() => gemini.map(file => path.basename(file))).toEqual([
            'stream-gemini-2.5-flash-image-image-2K.yml',
            'stream-gemini-2.5-flash-image-image.yml',
            'stream-gemini-2.5-flash-json.yml',
            'stream-gemini-2.5-flash-text.yml',
            'stream-gemini-3-pro-image-preview-image-2K.yml',
            'stream-gemini-3.1-flash-image-preview-image-2K.yml',
        ]);
        expect2(() => geminiNative.map(file => path.basename(file))).toEqual([
            'generate-content-stream-image.json',
            'generate-content-stream-json.json',
            'generate-content-stream-text.json',
        ]);
    });

    it('should keep image artifacts referenced by stream fixtures', () => {
        const fixtureFiles = [...listFiles('openai', /^stream-.*\.yml$/), ...listFiles('gemini', /^stream-.*\.yml$/)];
        const refs = Array.from(
            new Set(
                fixtureFiles.flatMap(file =>
                    Array.from(read(file).matchAll(/sample\/image\/[A-Za-z0-9._-]+/g)).map(match => match[0]),
                ),
            ),
        ).sort();

        expect2(() => refs).toEqual([
            'sample/image/33e47403d5a593712759cd94a8eb4cb9fceb9e94b7cf9c4da1c6b933083d858e.jpg',
            'sample/image/92ed36b7293cac78edeeac8f866bcd7d9589a7c72f900b8aef2527e70667e879.png',
            'sample/image/99108ce2b73dfa9e7be251973a0edf111fe42c27743ebebeebe7da8dc0868b8c.png',
            'sample/image/c4bf7d5471383a04ce93b26ce751ccabb9a3b6ad7bf9007a3f46fa3ade091996.png',
            'sample/image/db49ec262397c594d6522cde5fded5ee71d2fb2ccd13f683e784190286857551.png',
            'sample/image/eb84bd5b8f8f1e7fec128a683f9d16a00692b68dbed6231fdfad09460bf57d41.jpg',
        ]);
        expect2(() => refs.every(file => fs.existsSync(path.join(repoRoot, file)))).toEqual(true);
    });
});
