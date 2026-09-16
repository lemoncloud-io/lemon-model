/**
 * `upload/engine/executors.ts`
 * - one executor per `UploadTransfer` kind. **this is the only file that grows when the server
 *   changes how bytes travel** — `UploadEngine` never does.
 * - each executor takes its HTTP primitive from the shell: a fetch-based adapter reports no
 *   progress, an `XMLHttpRequest`-based one forwards `upload.onprogress`.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import type {
    UploadCompleteItem,
    UploadInlineTransfer,
    UploadPresignedPutTransfer,
    UploadSendBody,
    UploadView,
} from '../types';
import { UPLOAD_FAILURE_CODE, UPLOAD_FAILURE_SOURCE, UPLOAD_TRANSFER_KIND } from '../types';
import type { UploadSource, UploadTransferExecutor } from './engine';
import { asApiFailure, asStorageFailure } from './engine';
import type { UploadProgressSink, UploadWireProgress } from './progress';
import { asContentBytes } from './progress';

/**
 * the `send` call as the shell provides it.
 * - a fetch-based API adapter is `(id, body) => service.send(id, body)` and reports nothing;
 * - an `XMLHttpRequest`-based one forwards `upload.onprogress` through `onProgress`.
 */
export type InlineSendCall = (id: string, body: UploadSendBody, onProgress?: UploadWireProgress) => Promise<UploadView>;

/** roadmap 1 — the only place that knows bytes go to our API as base64 */
export class InlineExecutor implements UploadTransferExecutor<UploadInlineTransfer> {
    public readonly kind = UPLOAD_TRANSFER_KIND.inline;

    public constructor(
        private readonly send: InlineSendCall,
        /** shell-specific base64 encoder (btoa / Buffer / RN polyfill) */
        private readonly toBase64: (bytes: Uint8Array) => string,
    ) {}

    public async run(
        id: string,
        transfer: UploadInlineTransfer,
        source: UploadSource,
        onProgress: UploadProgressSink,
    ): Promise<UploadCompleteItem> {
        if (source.contentSize > transfer.maxBytes) {
            return { id, failure: { source: UPLOAD_FAILURE_SOURCE.client, code: UPLOAD_FAILURE_CODE.tooLarge } };
        }
        try {
            const body: UploadSendBody = { content: this.toBase64(await source.bytes()) };
            // wire bytes are base64 JSON (~4/3 of the send): report in send bytes
            await this.send(id, body, (loaded, total) => onProgress(asContentBytes(loaded, total, source.contentSize)));
            return { id };
        } catch (error) {
            return { id, failure: asApiFailure(error) };
        }
    }
}

/**
 * raw HTTP PUT provided by the shell; `code` = parsed S3 `<Code>`.
 * - fetch-based: never calls `onProgress`. `XMLHttpRequest`-based: forwards `upload.onprogress`.
 */
export type RawPut = (
    url: string,
    headers: Record<string, string>,
    body: Uint8Array,
    onProgress?: UploadWireProgress,
) => Promise<{ status: number; code?: string }>;

/** roadmap 2 — added next to `InlineExecutor`; `UploadEngine` is untouched */
export class PresignedPutExecutor implements UploadTransferExecutor<UploadPresignedPutTransfer> {
    public readonly kind = UPLOAD_TRANSFER_KIND.presignedPut;

    public constructor(private readonly put: RawPut) {}

    public async run(
        id: string,
        transfer: UploadPresignedPutTransfer,
        source: UploadSource,
        onProgress: UploadProgressSink,
    ): Promise<UploadCompleteItem> {
        const res = await this.put(transfer.url, transfer.headers, await source.bytes(), (loaded, total) =>
            onProgress(asContentBytes(loaded, total, source.contentSize)),
        );
        if (res.status >= 200 && res.status < 300) return { id };
        // 412 = object already exists under this key; the server decides at complete
        if (res.status === 412) return { id };
        return { id, failure: asStorageFailure(res.status, res.code) };
    }
}
