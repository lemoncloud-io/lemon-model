/**
 * `upload/testing.ts`
 * - shared fixtures so a server spec and a client spec assert against the same payloads.
 * - kept OUT of the root barrel like the other `<module>/testing` entries: `lemon-model/upload/testing`.
 * - fixtures never carry a real signature or a real host.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import type { Upload, UploadTicket } from './types';
import { UPLOAD_STATUS, UPLOAD_STEREO, UPLOAD_TRANSFER_KIND } from './types';

/** a settled image as the server returns it after `complete`, with the preview the client sent */
export const SAMPLE_UPLOAD_STORED: Upload = {
    id: 'up-001',
    status: UPLOAD_STATUS.stored,
    stereo: UPLOAD_STEREO.image,
    name: 'photo.png',
    contentType: 'image/png',
    contentSize: 123456,
    url: 'https://cdn.example.com/up-001.png',
    width: 1024,
    height: 768,
    thumbnail: { url: 'https://cdn.example.com/up-001-thumb.jpg', contentType: 'image/jpeg' },
};

/** start slot: inline ticket (roadmap 1) */
export const SAMPLE_UPLOAD_TICKET_INLINE: UploadTicket = {
    upload: {
        id: 'up-002',
        status: UPLOAD_STATUS.pending,
        stereo: UPLOAD_STEREO.image,
        name: 'photo.png',
        contentType: 'image/png',
        contentSize: 123456,
    },
    transfer: { kind: UPLOAD_TRANSFER_KIND.inline, maxBytes: 4000000 },
};

/** start slot: presigned ticket (roadmap 2) */
export const SAMPLE_UPLOAD_TICKET_PRESIGNED: UploadTicket = {
    upload: {
        id: 'up-003',
        status: UPLOAD_STATUS.pending,
        stereo: UPLOAD_STEREO.image,
        name: 'photo.png',
        contentType: 'image/png',
        contentSize: 123456,
    },
    transfer: {
        kind: UPLOAD_TRANSFER_KIND.presignedPut,
        method: 'PUT',
        url: 'https://storage.example.com/up-003?X-Amz-Signature=masked',
        headers: { 'content-type': 'image/png', 'content-length': '123456' },
        maxBytes: 50000000,
        expiresAt: 1757895300000,
    },
};

/** start slot rejected at validation: no id, nothing to transfer or complete */
export const SAMPLE_UPLOAD_REJECTED: UploadTicket = {
    upload: {
        status: UPLOAD_STATUS.failed,
        name: 'big.png',
        contentType: 'image/png',
        contentSize: 6291456,
        error: '413 TOO LARGE - 6291456 > 4000000',
    },
};
