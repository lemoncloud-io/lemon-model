/**
 * `upload/types.spec.ts`
 * - pure function and LUT tests for the upload contract (SPEC.md §2.2).
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../cores/index.spec';
import {
    isUploadStored,
    UPLOAD_FAILURE_CODE,
    UPLOAD_FAILURE_SOURCE,
    UPLOAD_ROUTES,
    UPLOAD_STEREO,
    UPLOAD_TRANSFER_KIND,
    uploadStereoOf,
    UploadView,
} from './types';

describe('upload/types', () => {
    describe('isUploadStored()', () => {
        it('is true only when status is stored and id/url are both strings', () => {
            const stored: UploadView = {
                id: 'up-001',
                status: 'stored',
                url: 'https://cdn.example.com/up-001.png',
            };
            expect2(() => isUploadStored(stored)).toEqual(true);
        });

        it('is false for pending, failed, and stored-without-id/url', () => {
            expect2(() => isUploadStored({ status: 'pending' } as UploadView)).toEqual(false);
            expect2(() => isUploadStored({ status: 'failed' } as UploadView)).toEqual(false);
            expect2(() =>
                isUploadStored({ status: 'stored', url: 'https://cdn.example.com/up-001.png' } as UploadView),
            ).toEqual(false);
            expect2(() => isUploadStored({ status: 'stored', id: 'up-001' } as UploadView)).toEqual(false);
        });
    });

    describe('uploadStereoOf()', () => {
        it('maps image/video/audio/pdf content types to their stereo', () => {
            expect2(() => uploadStereoOf('image/png')).toEqual(UPLOAD_STEREO.image);
            expect2(() => uploadStereoOf('video/mp4')).toEqual(UPLOAD_STEREO.video);
            expect2(() => uploadStereoOf('audio/mpeg')).toEqual(UPLOAD_STEREO.sound);
            expect2(() => uploadStereoOf('application/pdf')).toEqual(UPLOAD_STEREO.docs);
        });

        it('is case-insensitive and ignores a charset parameter', () => {
            expect2(() => uploadStereoOf('IMAGE/PNG')).toEqual(UPLOAD_STEREO.image);
            expect2(() => uploadStereoOf('image/png; charset=binary')).toEqual(UPLOAD_STEREO.image);
        });

        it('returns undefined for an unsupported content type', () => {
            expect2(() => uploadStereoOf('application/zip')).toEqual(undefined);
        });
    });

    describe('LUT values', () => {
        it('UPLOAD_STEREO', () => {
            expect2(() => UPLOAD_STEREO).toEqual({
                image: 'image',
                video: 'video',
                sound: 'sound',
                docs: 'docs',
            });
        });

        it('UPLOAD_ROUTES', () => {
            expect2(() => UPLOAD_ROUTES).toEqual({
                start: { method: 'POST', path: '/start' },
                send: { method: 'POST', path: '/{id}/send' },
                complete: { method: 'POST', path: '/complete' },
                read: { method: 'GET', path: '/{id}' },
            });
        });

        it('UPLOAD_TRANSFER_KIND', () => {
            expect2(() => UPLOAD_TRANSFER_KIND).toEqual({
                inline: 'inline',
                presignedPut: 'presigned-put',
            });
        });

        it('UPLOAD_FAILURE_CODE', () => {
            expect2(() => UPLOAD_FAILURE_CODE).toEqual({
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
            });
        });

        it('UPLOAD_FAILURE_SOURCE', () => {
            expect2(() => UPLOAD_FAILURE_SOURCE).toEqual({
                api: 'api',
                storage: 'storage',
                client: 'client',
            });
        });
    });
});
