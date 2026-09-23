/**
 * `upload/engine/engine.ts`
 * - the one upload flow every shell shares: `start` -> run executors -> `complete`.
 * - swapping the server's transfer method never touches this file; a new `UploadTransfer` kind
 *   arrives as one more `UploadTransferExecutor` passed to the constructor.
 * - runtime-neutral like the contract itself: no Node, DOM, or AWS types. the shell injects the
 *   three things that are shell-specific — reading bytes (`UploadSource`), the HTTP primitives
 *   (see `./executors`), and hashing.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import type {
    Upload,
    UploadCompleteItem,
    UploadContent,
    UploadDirectTransfer,
    UploadFailure,
    UploadFailureCode,
    UploadIntent,
    UploadSupportable,
    UploadTicket,
    UploadTransfer,
    UploadTransferKind,
} from '../types';
import { UPLOAD_FAILURE_CODE, UPLOAD_FAILURE_SOURCE } from '../types';
import type { UploadBatchProgressSink, UploadProgressSink } from './progress';
import { UploadProgressTracker } from './progress';

/**
 * one payload of bytes a shell can hand over: the contract's `UploadContent`, with the bytes behind a call.
 * - the contract's `hash` is a string and this one is a call, so this does not extend `UploadContent`.
 */
export interface UploadContentSource {
    contentType: string;
    contentSize: number;
    /** pixel size for image/video; echoed into the intent so a list screen can reserve the box */
    width?: number;
    height?: number;
    /** the whole payload in one call */
    bytes(): Promise<Uint8Array>;
    /** sha256 hex(64) when this shell chooses to hash at send time; omit to skip */
    hash?(): Promise<string | undefined>;
}

/** bytes provider; hides DOM `File`, RN uri, Electron path behind one shape */
export interface UploadSource extends UploadContentSource {
    name: string;
    /** a preview this shell already made. the engine sends it beside the original and never derives one */
    thumbnail?: UploadContentSource;
}

/** moves bytes for one transfer kind and reports the receipt the server expects in `complete` */
export interface UploadTransferExecutor<T extends UploadTransfer = UploadTransfer> {
    readonly kind: T['kind'];
    /**
     * `onProgress` is optional to CALL, not to accept: an executor that cannot observe bytes never calls it.
     * - `source` is a payload, not a file: the engine passes `source.thumbnail` here too, and that has no `name`.
     */
    run(
        id: string,
        transfer: T,
        source: UploadContentSource,
        onProgress: UploadProgressSink,
    ): Promise<UploadCompleteItem>;
}

/**
 * transfers in flight at once.
 * - a browser queues beyond ~6 per origin, and a queued presigned url burns its `expiresAt` while it waits.
 * - override per engine when a shell measures something better.
 */
export const UPLOAD_DEFAULT_CONCURRENCY = 3;

/** run `task` over 0..count-1 with at most `limit` in flight; results keep input order */
const runPooled = async <T>(count: number, limit: number, task: (index: number) => Promise<T>): Promise<T[]> => {
    const results: T[] = new Array(count);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = next++;
            if (index >= count) return;
            results[index] = await task(index);
        }
    };
    const size = Math.max(1, Math.min(limit, count));
    await Promise.all(new Array(size).fill(0).map(() => worker()));
    return results;
};

const asContent = async (source: UploadContentSource): Promise<UploadContent> => ({
    contentType: source.contentType,
    contentSize: source.contentSize,
    width: source.width,
    height: source.height,
    hash: source.hash ? await source.hash() : undefined,
});

const asIntent = async (source: UploadSource): Promise<UploadIntent> => ({
    ...(await asContent(source)),
    name: source.name,
    thumbnail: source.thumbnail ? await asContent(source.thumbnail) : undefined,
});

/** bytes this source puts on the wire in total; the thumbnail rides along so the bar counts it */
const sizeOf = (source: UploadSource): number => source.contentSize + (source.thumbnail?.contentSize ?? 0);

export class UploadEngine {
    private readonly kinds: UploadTransferKind[];

    public constructor(
        private readonly service: UploadSupportable,
        private readonly executors: ReadonlyArray<UploadTransferExecutor>,
        private readonly options?: { concurrency?: number },
    ) {
        this.kinds = executors.map(executor => executor.kind);
    }

    /** returns one view per source, in order: `stored`, or `failed` with the reason. `onProgress` gets a snapshot per change */
    public async upload(sources: ReadonlyArray<UploadSource>, onProgress?: UploadBatchProgressSink): Promise<Upload[]> {
        const tracker = new UploadProgressTracker(sources.map(sizeOf), onProgress);
        tracker.publish();
        const list = await Promise.all(sources.map(asIntent));
        const { list: tickets } = await this.service.start({ list, transfers: this.kinds });
        const limit = this.options?.concurrency ?? UPLOAD_DEFAULT_CONCURRENCY;
        const receipts = await runPooled(tickets.length, limit, i =>
            this.transferTracked(tickets[i], sources[i], tracker, i),
        );
        // a server that broke rule 1 (shorter list) must not leave the bar hanging
        sources.forEach((_, i) => tracker.settle(i));
        const pending = receipts.filter((item): item is UploadCompleteItem => !!item);
        const settled = pending.length ? (await this.service.complete({ list: pending })).list : [];
        const byId = new Map(
            settled.filter(upload => !!upload.id).map((upload): [string, Upload] => [upload.id as string, upload]),
        );
        return tickets.map(ticket => (ticket.upload.id && byId.get(ticket.upload.id)) || ticket.upload);
    }

    private async transferTracked(
        ticket: UploadTicket,
        source: UploadSource,
        tracker: UploadProgressTracker,
        index: number,
    ): Promise<UploadCompleteItem | undefined> {
        try {
            return await this.transfer(ticket, source, tracker.sink(index));
        } catch (error) {
            // an executor that throws (a CORS preflight failure surfaces as one) must not take the batch down
            const id = ticket.upload.id;
            if (!id) return undefined;
            const message = error instanceof Error ? error.message : String(error);
            return {
                id,
                failure: { source: UPLOAD_FAILURE_SOURCE.client, code: UPLOAD_FAILURE_CODE.unknown, message },
            };
        } finally {
            tracker.settle(index);
        }
    }

    private async transfer(
        ticket: UploadTicket,
        source: UploadSource,
        onProgress: UploadProgressSink,
    ): Promise<UploadCompleteItem | undefined> {
        const id = ticket.upload.id;
        // rejected at start: nothing was created, nothing to complete
        if (!id) return undefined;
        const receipt = await this.transferOriginal(id, ticket.transfer, source, onProgress);
        // a failed original has nothing to preview; otherwise the thumbnail rides after it (never with it)
        if (!receipt.failure) await this.transferThumbnail(id, ticket.thumbnailTransfer, source, onProgress);
        return receipt;
    }

    private async transferOriginal(
        id: string,
        transfer: UploadTransfer | undefined,
        source: UploadSource,
        onProgress: UploadProgressSink,
    ): Promise<UploadCompleteItem> {
        // no instruction: already stored (dedup, or a stored upload taking only a thumbnail) — complete still confirms it
        if (!transfer) return { id };
        const executor = this.executors.find(candidate => candidate.kind === transfer.kind);
        if (!executor)
            return { id, failure: { source: UPLOAD_FAILURE_SOURCE.client, code: UPLOAD_FAILURE_CODE.notAcceptable } };
        // NOTE: `transfer` must not be logged or stored — it may carry a credential url
        return executor.run(id, transfer, source, onProgress);
    }

    /**
     * the preview is subordinate: whatever happens here never reaches `complete`.
     * - `UploadCompleteItem` is one per upload, so reporting a thumbnail failure would fail the original.
     * - the server settles the thumbnail by looking at storage at `complete` time, so silence is enough.
     */
    private async transferThumbnail(
        id: string,
        transfer: UploadDirectTransfer | undefined,
        source: UploadSource,
        onProgress: UploadProgressSink,
    ): Promise<void> {
        const thumbnail = source.thumbnail;
        if (!transfer || !thumbnail) return;
        const executor = this.executors.find(candidate => candidate.kind === transfer.kind);
        if (!executor) return;
        // the original's bytes are already counted, so the thumbnail reports on top of them
        const base = source.contentSize;
        try {
            await executor.run(id, transfer, thumbnail, sent => onProgress(base + sent));
        } catch {
            // swallowed on purpose: see the note above
        }
    }
}

/** lemon-core error convention: "<status> <LABEL> - <detail>" (status 0 = no response, XHR convention) */
const API_ERROR = /^(\d{1,3}) ([A-Z][A-Z ]*?) - ([\s\S]*)$/;

const codeOfApiStatus = (status: number): UploadFailureCode => {
    switch (status) {
        case 0:
            return UPLOAD_FAILURE_CODE.network;
        case 400:
            return UPLOAD_FAILURE_CODE.invalid;
        case 404:
            return UPLOAD_FAILURE_CODE.notFound;
        case 406:
            return UPLOAD_FAILURE_CODE.notAcceptable;
        case 409:
            return UPLOAD_FAILURE_CODE.conflict;
        case 410:
            return UPLOAD_FAILURE_CODE.expired;
        case 413:
            return UPLOAD_FAILURE_CODE.tooLarge;
        case 415:
            return UPLOAD_FAILURE_CODE.unsupported;
        default:
            return UPLOAD_FAILURE_CODE.unknown;
    }
};

/** normalize an error thrown by the API adapter */
export const asApiFailure = (error: unknown): UploadFailure => {
    const message = error instanceof Error ? error.message : String(error);
    const match = API_ERROR.exec(message);
    if (!match) return { source: UPLOAD_FAILURE_SOURCE.api, code: UPLOAD_FAILURE_CODE.unknown, message };
    const status = Number(match[1]);
    return {
        source: UPLOAD_FAILURE_SOURCE.api,
        code: codeOfApiStatus(status),
        status,
        reason: match[2],
        message: match[3],
    };
};

/** S3 error `<Code>` -> normalized code. unknown codes fall back by status */
const STORAGE_CODES: Record<string, UploadFailureCode> = {
    SignatureDoesNotMatch: UPLOAD_FAILURE_CODE.signature,
    AccessDenied: UPLOAD_FAILURE_CODE.expired,
    ExpiredToken: UPLOAD_FAILURE_CODE.expired,
    BadDigest: UPLOAD_FAILURE_CODE.checksum,
    XAmzContentSHA256Mismatch: UPLOAD_FAILURE_CODE.checksum,
    EntityTooLarge: UPLOAD_FAILURE_CODE.tooLarge,
    RequestTimeout: UPLOAD_FAILURE_CODE.network,
};

/** normalize a non-2xx answer from the storage endpoint (status 0 = no response) */
export const asStorageFailure = (status: number, code?: string): UploadFailure => {
    const known = code ? STORAGE_CODES[code] : undefined;
    const byStatus =
        status === 0
            ? UPLOAD_FAILURE_CODE.network
            : status === 403
            ? UPLOAD_FAILURE_CODE.signature
            : status === 413
            ? UPLOAD_FAILURE_CODE.tooLarge
            : UPLOAD_FAILURE_CODE.unknown;
    return { source: UPLOAD_FAILURE_SOURCE.storage, code: known ?? byStatus, status, reason: code };
};
