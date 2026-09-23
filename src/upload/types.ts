/**
 * `upload/types.ts`
 * - client <-> server contract for uploading files.
 * - transport-neutral: the client always runs `start` -> transfer -> `complete`; whether the server
 *   stores bytes inline (base64 in JSON) or hands out a presigned PUT only changes which
 *   `UploadTransfer` variant it issues.
 * - runtime-neutral like `socket/`: no Node, DOM, or AWS SDK types. Storage coordinates
 *   (bucket, key, region) never appear here.
 * - model-neutral: nothing here imports or names lemon-core's Model/View/Body/Head layers or the `$`
 *   embed marker. two shapes carry the vocabulary instead — `UploadContent` (bytes as declared) and
 *   `UploadResource` (bytes as stored, with an address). how a server maps them onto its own model
 *   layer, and how it embeds an upload in another record, is the server's concern.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */

/** kind of stored content. same vocabulary as lemon-uploads-api `MediaStereo` minus its internal markers */
export const UPLOAD_STEREO = {
    image: 'image',
    video: 'video',
    sound: 'sound',
    docs: 'docs',
} as const;
export type UploadStereo = typeof UPLOAD_STEREO[keyof typeof UPLOAD_STEREO];

/** lifecycle of one upload as the client sees it. `url` is meaningful only when `stored` */
export const UPLOAD_STATUS = {
    /** ticket issued; bytes not confirmed by the server yet */
    pending: 'pending',
    /** bytes durable and `url` valid */
    stored: 'stored',
    /** terminal; `error` carries the server's detail */
    failed: 'failed',
} as const;
export type UploadStatus = typeof UPLOAD_STATUS[keyof typeof UPLOAD_STATUS];

/** how bytes travel. the only axis that changes across the roadmap */
export const UPLOAD_TRANSFER_KIND = {
    /** base64 JSON to the API via the `send` operation (roadmap 1) */
    inline: 'inline',
    /** HTTP PUT straight to storage with a server-issued url + headers (roadmap 2) */
    presignedPut: 'presigned-put',
} as const;
export type UploadTransferKind = typeof UPLOAD_TRANSFER_KIND[keyof typeof UPLOAD_TRANSFER_KIND];

/**
 * one payload of bytes as the client declares it. it has no identity and no address of its own.
 * - `contentType` and `contentSize` are required: the server picks the transfer and validates limits
 *   from them before any byte moves.
 */
export interface UploadContent {
    contentType: string;
    contentSize: number;
    /** pixel size for image/video. declared by the client; the server does not verify it */
    width?: number;
    height?: number;
    /**
     * sha256 hex(64). optional forever: servers MUST accept uploads without it, MUST verify it when given.
     * on a thumbnail the server MAY verify it the same way for that transfer; completion-time cross-check applies only to the original's hash.
     */
    hash?: string;
}

/**
 * bytes the server holds, and where to fetch them.
 * - `url` may be time-limited and re-issued on every read: use it when received, never persist it.
 * - the content fields are what the server can vouch for, so every one is optional: a server that
 *   only confirmed the object exists (a thumbnail) knows nothing beyond the address.
 */
export interface UploadResource extends Partial<UploadContent> {
    url: string;
}

/**
 * one upload intent: a slot of `start`.
 * - `id` set = re-issue transfers for an existing upload. for a still-`pending` one (expired ticket)
 *   that is both transfers; for a `stored` one it is `thumbnailTransfer` only, because stored bytes
 *   are immutable.
 */
export interface UploadIntent extends UploadContent {
    id?: string;
    /** file name as the sender picked it */
    name: string;
    /** a preview the client made. the server stores it beside the original and never derives it */
    thumbnail?: UploadContent;
}

/**
 * one upload as the server reports it: the declaration, its lifecycle, and — once `stored` — its address.
 * - the content fields echo the intent. `url` is present iff `status` is `stored` (see `UploadStored`).
 * - a server may answer with more fields than these; a client relies on these only.
 */
export interface Upload extends Partial<UploadContent> {
    /** absent only for a slot rejected at `start` validation: nothing was created */
    id?: string;
    status: UploadStatus;
    /** human-readable detail when `failed`; the format is the server's. branch on `status`, not on this string */
    error?: string;
    stereo?: UploadStereo;
    /** file name as the sender picked it */
    name?: string;
    /** url to serve; may be time-limited and re-issued on every read — do not persist it. present iff `stored` */
    url?: string;
    /** preview stored alongside the original: present only once the intent declared one and its bytes arrived */
    thumbnail?: UploadResource;
}

/** an upload whose bytes are durable: it has an `id` and it is an `UploadResource` */
export type UploadStored = Upload & UploadResource & { id: string };

export const isUploadStored = (upload: Upload): upload is UploadStored =>
    upload.status === UPLOAD_STATUS.stored && typeof upload.id === 'string' && typeof upload.url === 'string';

/** transfer instruction (roadmap 1): send base64 through `UploadService.send()` */
export interface UploadInlineTransfer {
    kind: typeof UPLOAD_TRANSFER_KIND.inline;
    /** max original bytes (before base64) this server accepts inline */
    maxBytes: number;
}

/**
 * transfer instruction (roadmap 2): PUT the raw bytes to `url` with `headers` verbatim.
 * - `url` is a credential. never log, persist, or put it in an error message.
 * - `expiresAt` is an upper bound only (signing credentials may expire earlier). on 403 re-`start` with `id`.
 */
export interface UploadPresignedPutTransfer {
    kind: typeof UPLOAD_TRANSFER_KIND.presignedPut;
    method: 'PUT';
    url: string;
    /**
     * every header the signature covers; send them unchanged.
     * - EXCEPT the ones the user agent owns: `content-length` and `host`. `fetch` and
     *   `XMLHttpRequest` forbid setting them and the UA fills them from the request itself,
     *   so a shell adapter must drop them from this map before sending. The signature still
     *   matches because the UA's value is the one that was signed.
     */
    headers: Record<string, string>;
    maxBytes: number;
    /** epoch-ms */
    expiresAt?: number;
}

export type UploadTransfer = UploadInlineTransfer | UploadPresignedPutTransfer;

/**
 * one slot of `start`'s answer.
 * - `upload` is safe to store and log. `transfer` and `thumbnailTransfer` are each consumed once by
 *   the executor and dropped.
 * - nothing to send at all = neither `transfer` nor `thumbnailTransfer`: already `stored` (dedup)
 *   or `failed` at validation. `transfer` alone may be absent while `thumbnailTransfer` is present —
 *   that is a `stored` upload getting a thumbnail added; its bytes are immutable.
 */
export interface UploadTicket {
    upload: Upload;
    transfer?: UploadTransfer;
    /**
     * transfer instruction for the thumbnail, when the intent declared one. absent = nothing to send.
     * - it is never `inline`: the `send` operation addresses the upload, not one of its payloads,
     *   so inline bytes would land on the original. a server with no addressable transfer for a
     *   thumbnail simply omits this and stores the original alone.
     */
    thumbnailTransfer?: UploadPresignedPutTransfer;
}

/** body of the `start` operation */
export interface UploadStartBody {
    list: UploadIntent[];
    /** transfer kinds this client can execute, preferred first. absent = `['inline']` */
    transfers?: UploadTransferKind[];
}

/** same length and order as `UploadStartBody.list` */
export interface UploadStartResult {
    list: UploadTicket[];
}

/** body of the `send` operation (inline transfer only) */
export interface UploadSendBody {
    /** base64 of the whole content; size must match the declared `contentSize` */
    content: string;
}

/** who produced a failure */
export const UPLOAD_FAILURE_SOURCE = {
    /** our API answered with an error */
    api: 'api',
    /** the storage endpoint (presigned PUT) answered with an error */
    storage: 'storage',
    /** the client gave up before or without a response */
    client: 'client',
} as const;
export type UploadFailureSource = typeof UPLOAD_FAILURE_SOURCE[keyof typeof UPLOAD_FAILURE_SOURCE];

/** normalized failure codes; the app branches on these, never on raw HTTP status */
export const UPLOAD_FAILURE_CODE = {
    invalid: 'invalid',
    tooLarge: 'too-large',
    unsupported: 'unsupported',
    notAcceptable: 'not-acceptable',
    notFound: 'not-found',
    conflict: 'conflict',
    expired: 'expired',
    signature: 'signature',
    checksum: 'checksum',
    network: 'network',
    aborted: 'aborted',
    unknown: 'unknown',
} as const;
export type UploadFailureCode = typeof UPLOAD_FAILURE_CODE[keyof typeof UPLOAD_FAILURE_CODE];

/** failure as the client reports it (to the app, and to the server in `complete`) */
export interface UploadFailure {
    source: UploadFailureSource;
    code: UploadFailureCode;
    /** HTTP status as observed, if any */
    status?: number;
    /** origin code: S3 `<Code>` or the lemon-core LABEL */
    reason?: string;
    /** human detail. MUST NOT contain a transfer url */
    message?: string;
}

/** one slot of `complete`'s request */
export interface UploadCompleteItem {
    id: string;
    /** set when the transfer did not succeed; the server marks the upload `failed` */
    failure?: UploadFailure;
}

/** body of the `complete` operation */
export interface UploadCompleteBody {
    list: UploadCompleteItem[];
}

/** same length and order as `UploadCompleteBody.list` */
export interface UploadCompleteResult {
    list: Upload[];
}

/**
 * the four operations. the server controller and the client API adapter both implement this.
 * - all four require the caller's normal API auth; a presigned url is the only unauthenticated hop.
 */
export interface UploadService {
    /** declare intents; get tickets. validation failures come back per slot as `failed`, never as HTTP 4xx */
    start(body: UploadStartBody): Promise<UploadStartResult>;
    /** inline transfer: deliver the bytes of one pending upload */
    send(id: string, body: UploadSendBody): Promise<Upload>;
    /** confirm; the server verifies what it cannot see (presigned) and settles `status`. idempotent */
    complete(body: UploadCompleteBody): Promise<UploadCompleteResult>;
    /** re-read for the current state */
    read(id: string): Promise<Upload>;
}

/** HTTP binding relative to the server's upload base path (lemon-core `/{type}/{id}/{cmd}` shape) */
export const UPLOAD_ROUTES = {
    start: { method: 'POST', path: '/start' },
    send: { method: 'POST', path: '/{id}/send' },
    complete: { method: 'POST', path: '/complete' },
    read: { method: 'GET', path: '/{id}' },
} as const;

/** shared stereo derivation so an optimistic client tile and the server agree */
export const uploadStereoOf = (contentType: string): UploadStereo | undefined => {
    const type = contentType.toLowerCase().split(';')[0].trim();
    if (type.startsWith('image/')) return UPLOAD_STEREO.image;
    if (type.startsWith('video/')) return UPLOAD_STEREO.video;
    if (type.startsWith('audio/')) return UPLOAD_STEREO.sound;
    if (type === 'application/pdf') return UPLOAD_STEREO.docs;
    return undefined;
};
