/**
 * `buffer/tools.spec.ts`
 * - probe helper compatibility tests for tools/common.ts.
 *
 * @origin eureka-agents-api / tools/common.ts
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import { GenAIStreamEvent } from './stream';
import { parseDataUrl, redactBufferEvent, summarizeBufferEvent } from '../../tools/common';

describe('buffer probe tools', () => {
    it('should summarize GenAI stream buffer events', () => {
        const event: GenAIStreamEvent = {
            type: 'flush',
            index: 3,
            createdAt: 1100,
            data: 'hello',
            chunks: [{ type: 'chunk', data: 'hello', chars: 5, bytes: 5 }],
            count: 1,
            chars: 5,
            bytes: 5,
            meta: { provider: 'mock', model: 'mock-model', kind: 'text' },
            progress: {
                loadedChars: 5,
                loadedBytes: 5,
                percent: 50,
                bufferPercent: 100,
                estimated: true,
            },
        };

        expect2(() => summarizeBufferEvent(event, 0, 1000)).toEqual({
            index: 0,
            type: 'flush',
            eventIndex: 3,
            elapsedMs: 100,
            dataLength: 5,
            count: 1,
            chars: 5,
            bytes: 5,
            progress: {
                loadedChars: 5,
                loadedBytes: 5,
                percent: 50,
                bufferPercent: 100,
                estimated: true,
            },
            meta: { provider: 'mock', model: 'mock-model', kind: 'text' },
        });
    });

    it('should redact image payloads in probe buffer events', () => {
        const data = 'data:image/png;base64,QUJDRA==';
        const event: GenAIStreamEvent = {
            type: 'flush',
            data,
            chunks: [{ type: 'chunk', data, chars: data.length, bytes: data.length }],
            count: 1,
            chars: data.length,
            bytes: data.length,
            meta: { kind: 'image' },
            progress: {
                loadedChars: data.length,
                loadedBytes: data.length,
                bufferPercent: 100,
                estimated: true,
            },
        };

        expect2(() => parseDataUrl(data)).toEqual({ mimeType: 'image/png', base64: 'QUJDRA==' });
        expect2(() => redactBufferEvent(event), 'type,data,chunks').toEqual({
            type: 'flush',
            data: {
                omitted: true,
                mimeType: 'image/png',
                dataUrlLength: data.length,
                base64Length: 8,
            },
            chunks: [
                {
                    type: 'chunk',
                    chars: data.length,
                    bytes: data.length,
                    data: {
                        omitted: true,
                        mimeType: 'image/png',
                        dataUrlLength: data.length,
                        base64Length: 8,
                    },
                },
            ],
        });
    });
});
