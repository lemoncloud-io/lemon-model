/**
 * `upload/types.ts`
 * - client <-> server contract for uploading files.
 * - transport-neutral: the client always runs `start` -> transfer -> `complete`; whether the server
 *   stores bytes inline (base64 in JSON) or hands out a presigned PUT only changes which
 *   `UploadTransfer` variant it issues.
 * - runtime-neutral like `socket/`: no Node, DOM, or AWS SDK types. Storage coordinates
 *   (bucket, key, region) never appear here.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import type { Body, View } from '../cores/transformer';

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
    /** terminal; `error` carries "<status> <LABEL> - <detail>" */
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
 * snapshot other models embed as `upload$` / `upload$$` (see `UploadRef`, `UploadRefs`).
 * - what a list screen needs to draw a tile or a file chip without a second fetch.
 */
export interface UploadHead {
    id?: string;
    stereo?: UploadStereo;
    /** file name as the sender picked it */
    name?: string;
    /** MIME type */
    contentType?: string;
    /** size in bytes of the original content */
    contentSize?: number;
    /** stable url to serve; present iff status is `stored` */
    url?: string;
    /** thumbnail url; may arrive after `stored` (server post-processing) */
    thumbnail?: string;
    /** pixel size for image/video */
    width?: number;
    height?: number;
}

/** response layout of one upload */
export interface UploadView extends View, UploadHead {
    status: UploadStatus;
    /** sha256 hex(64) of the content, when known to the server */
    hash?: string;
}

/**
 * request layout of one upload intent.
 * - deviates from `XBody extends Body, Partial<XView>`: the three fields are required because
 *   the server picks the transfer and validates limits from them before any byte moves.
 * - inherited `id` set = re-issue the transfer of a still-`pending` upload (expired ticket).
 */
export interface UploadBody extends Body {
    name: string;
    contentType: string;
    contentSize: number;
    /** sha256 hex(64). optional forever: servers MUST accept uploads without it, MUST verify it when given */
    hash?: string;
}

/** single reference pair. add both fields or neither */
export interface UploadRef {
    uploadId?: string;
    upload$?: UploadHead;
}

/** array reference pair. add both fields or neither */
export interface UploadRefs {
    uploadIds?: string[];
    upload$$?: UploadHead[];
}

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
     *   matches because the UA's value is the one that was signed. `[실측]`
     */
    headers: Record<string, string>;
    maxBytes: number;
    /** epoch-ms */
    expiresAt?: number;
}

export type UploadTransfer = UploadInlineTransfer | UploadPresignedPutTransfer;

/**
 * one slot of `start`'s answer.
 * - `upload` is safe to store and log. `transfer` is consumed once by the executor and dropped.
 * - no `transfer` = nothing to send: already `stored` (dedup) or `failed` at validation.
 */
export interface UploadTicket {
    upload: UploadView;
    transfer?: UploadTransfer;
}

export interface UploadStartBody {
    list: UploadBody[];
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

export interface UploadCompleteBody {
    list: UploadCompleteItem[];
}

/** same length and order as `UploadCompleteBody.list` */
export interface UploadCompleteResult {
    list: UploadView[];
}

/**
 * the four operations. the server controller and the client API adapter both implement this.
 * - all four require the caller's normal API auth; a presigned url is the only unauthenticated hop.
 */
export interface UploadService {
    /** declare intents; get tickets. validation failures come back per slot as `failed`, never as HTTP 4xx */
    start(body: UploadStartBody): Promise<UploadStartResult>;
    /** inline transfer: deliver the bytes of one pending upload */
    send(id: string, body: UploadSendBody): Promise<UploadView>;
    /** confirm; the server verifies what it cannot see (presigned) and settles `status`. idempotent */
    complete(body: UploadCompleteBody): Promise<UploadCompleteResult>;
    /** re-read (post-processing fields may arrive later) */
    read(id: string): Promise<UploadView>;
}

/** HTTP binding relative to the server's upload base path (lemon-core `/{type}/{id}/{cmd}` shape) */
export const UPLOAD_ROUTES = {
    start: { method: 'POST', path: '/start' },
    send: { method: 'POST', path: '/{id}/send' },
    complete: { method: 'POST', path: '/complete' },
    read: { method: 'GET', path: '/{id}' },
} as const;

/** a view whose bytes are durable: `id` and `url` are guaranteed */
export type UploadStoredView = UploadView & { id: string; url: string };

export const isUploadStored = (view: UploadView): view is UploadStoredView =>
    view.status === UPLOAD_STATUS.stored && typeof view.id === 'string' && typeof view.url === 'string';

/** shared stereo derivation so an optimistic client tile and the server agree */
export const uploadStereoOf = (contentType: string): UploadStereo | undefined => {
    const type = contentType.toLowerCase().split(';')[0].trim();
    if (type.startsWith('image/')) return UPLOAD_STEREO.image;
    if (type.startsWith('video/')) return UPLOAD_STEREO.video;
    if (type.startsWith('audio/')) return UPLOAD_STEREO.sound;
    if (type === 'application/pdf') return UPLOAD_STEREO.docs;
    return undefined;
};
