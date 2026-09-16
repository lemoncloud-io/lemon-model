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
    UploadBody,
    UploadCompleteItem,
    UploadFailure,
    UploadFailureCode,
    UploadService,
    UploadTicket,
    UploadTransfer,
    UploadTransferKind,
    UploadView,
} from '../types';
import { UPLOAD_FAILURE_CODE, UPLOAD_FAILURE_SOURCE } from '../types';
import type { UploadBatchProgressSink, UploadProgressSink } from './progress';
import { UploadProgressTracker } from './progress';

/** bytes provider; hides DOM `File`, RN uri, Electron path behind one shape */
export interface UploadSource {
    name: string;
    contentType: string;
    contentSize: number;
    /** whole send (roadmap 1·2 sizes) */
    bytes(): Promise<Uint8Array>;
    /** sha256 hex(64) when this shell chooses to hash at send time; omit to skip */
    hash?(): Promise<string | undefined>;
}

/** moves bytes for one transfer kind and reports the receipt the server expects in `complete` */
export interface UploadTransferExecutor<T extends UploadTransfer = UploadTransfer> {
    readonly kind: T['kind'];
    /** `onProgress` is optional to CALL, not to accept: an executor that cannot observe bytes never calls it */
    run(id: string, transfer: T, source: UploadSource, onProgress: UploadProgressSink): Promise<UploadCompleteItem>;
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

const asBody = async (source: UploadSource): Promise<UploadBody> => ({
    name: source.name,
    contentType: source.contentType,
    contentSize: source.contentSize,
    hash: source.hash ? await source.hash() : undefined,
});

export class UploadEngine {
    private readonly kinds: UploadTransferKind[];

    public constructor(
        private readonly service: UploadService,
        private readonly executors: ReadonlyArray<UploadTransferExecutor>,
        private readonly options?: { concurrency?: number },
    ) {
        this.kinds = executors.map(executor => executor.kind);
    }

    /** returns one view per source, in order: `stored`, or `failed` with the reason. `onProgress` gets a snapshot per change */
    public async upload(
        sources: ReadonlyArray<UploadSource>,
        onProgress?: UploadBatchProgressSink,
    ): Promise<UploadView[]> {
        const tracker = new UploadProgressTracker(
            sources.map(source => source.contentSize),
            onProgress,
        );
        tracker.publish();
        const list = await Promise.all(sources.map(asBody));
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
            settled.filter(view => !!view.id).map((view): [string, UploadView] => [view.id as string, view]),
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
        // no instruction: already stored (dedup) — still confirmed through complete
        if (!ticket.transfer) return { id };
        const executor = this.executors.find(candidate => candidate.kind === ticket.transfer?.kind);
        if (!executor)
            return { id, failure: { source: UPLOAD_FAILURE_SOURCE.client, code: UPLOAD_FAILURE_CODE.notAcceptable } };
        // NOTE: `ticket.transfer` must not be logged or stored — it may carry a credential url
        return executor.run(id, ticket.transfer, source, onProgress);
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

/** S3 error `<Code>` -> normalized code (roadmap 2). unknown codes fall back by status */
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
