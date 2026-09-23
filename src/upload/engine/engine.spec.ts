/**
 * `upload/engine/engine.spec.ts`
 * - drives the engine against a fake `UploadService` built from the contract fixtures
 *   (`lemon-model/upload/testing`), so a client spec and a server spec assert the same payloads.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */
import { expect2 } from '../../cores/index.spec';
import type {
    UploadCompleteBody,
    UploadCompleteResult,
    UploadService,
    UploadStartBody,
    UploadStartResult,
    UploadTicket,
    Upload,
} from '../types';
import { UPLOAD_FAILURE_CODE, UPLOAD_FAILURE_SOURCE, UPLOAD_STATUS, UPLOAD_TRANSFER_KIND } from '../types';
import {
    SAMPLE_UPLOAD_TICKET_INLINE,
    SAMPLE_UPLOAD_TICKET_PRESIGNED,
    SAMPLE_UPLOAD_TICKET_THUMBNAIL_ONLY,
} from '../testing';
import type { UploadContentSource, UploadSource, UploadTransferExecutor } from './engine';
import { UploadEngine } from './engine';
import type { InlineSendCall, RawPut } from './executors';
import { InlineExecutor, PresignedPutExecutor } from './executors';
import type { UploadBatchProgress } from './progress';
import { UploadProgressTracker } from './progress';

/** a `start` answer of exactly these tickets; `complete` settles each item by its `failure` */
class FakeUploadService implements UploadService {
    public readonly started: UploadStartBody[] = [];
    public readonly completed: UploadCompleteBody[] = [];

    public constructor(private readonly tickets: UploadTicket[]) {}

    public async start(body: UploadStartBody): Promise<UploadStartResult> {
        this.started.push(body);
        return { list: this.tickets };
    }

    public async send(): Promise<Upload> {
        throw new Error('400 INVALID - send() must go through the executor');
    }

    public async complete(body: UploadCompleteBody): Promise<UploadCompleteResult> {
        this.completed.push(body);
        const list = body.list.map(
            (item): Upload => ({
                id: item.id,
                status: item.failure ? UPLOAD_STATUS.failed : UPLOAD_STATUS.stored,
                url: item.failure ? undefined : `https://cdn.example.com/${item.id}.png`,
            }),
        );
        return { list };
    }

    public async read(): Promise<Upload> {
        throw new Error('404 NOT FOUND - read() not wired');
    }
}

const sourceOf = (name: string, contentSize: number): UploadSource => ({
    name,
    contentType: 'image/png',
    contentSize,
    bytes: async () => new Uint8Array(4),
});

/** a payload with no name of its own — what `UploadSource.thumbnail` is */
const contentOf = (contentSize: number): UploadContentSource => ({
    contentType: 'image/jpeg',
    contentSize,
    bytes: async () => new Uint8Array(2),
});

/** encoder stub: the executor only forwards the string, so real base64 is not needed here */
const toBase64 = (bytes: Uint8Array) => `b64:${bytes.length}`;

/** an inline `send` that resolves, optionally reporting wire progress first */
const sendOk =
    (report?: [number, number]): InlineSendCall =>
    async (id, _body, onProgress) => {
        if (report && onProgress) onProgress(report[0], report[1]);
        return { id, status: UPLOAD_STATUS.stored };
    };

const ticketOf = (id: string): UploadTicket => ({
    ...SAMPLE_UPLOAD_TICKET_INLINE,
    upload: { ...SAMPLE_UPLOAD_TICKET_INLINE.upload, id },
});

describe('upload/engine', () => {
    it('sends both slots, calls complete once, and returns one stored view per source', async () => {
        const service = new FakeUploadService([ticketOf('up-002'), ticketOf('up-004')]);
        const engine = new UploadEngine(service, [new InlineExecutor(sendOk(), toBase64)]);
        const snapshots: UploadBatchProgress[] = [];

        const views = await engine.upload([sourceOf('a.png', 100), sourceOf('b.png', 300)], p => snapshots.push(p));

        expect2(() => service.started.length).toEqual(1);
        expect2(() => service.started[0].transfers).toEqual(['inline']);
        expect2(() => service.completed.length).toEqual(1);
        expect2(() => service.completed[0].list).toEqual([{ id: 'up-002' }, { id: 'up-004' }]);
        expect2(() => views.map(view => [view.id, view.status])).toEqual([
            ['up-002', 'stored'],
            ['up-004', 'stored'],
        ]);
        // the batch bar always ends full
        expect2(() => snapshots[snapshots.length - 1].ratio).toEqual(1);
    });

    it('fails only the slot whose transfer kind has no executor, without throwing', async () => {
        const service = new FakeUploadService([ticketOf('up-002'), SAMPLE_UPLOAD_TICKET_PRESIGNED]);
        const engine = new UploadEngine(service, [new InlineExecutor(sendOk(), toBase64)]);

        const views = await engine.upload([sourceOf('a.png', 100), sourceOf('b.png', 300)]);

        expect2(() => service.completed[0].list).toEqual([
            { id: 'up-002' },
            {
                id: 'up-003',
                failure: { source: UPLOAD_FAILURE_SOURCE.client, code: UPLOAD_FAILURE_CODE.notAcceptable },
            },
        ]);
        expect2(() => views.map(view => view.status)).toEqual(['stored', 'failed']);
    });

    it('carries a transfer failure into complete, normalized from the api error string', async () => {
        const send: InlineSendCall = async () => {
            throw new Error('413 TOO LARGE - 6291456 > 4000000');
        };
        const service = new FakeUploadService([ticketOf('up-002')]);
        const engine = new UploadEngine(service, [new InlineExecutor(send, toBase64)]);

        const views = await engine.upload([sourceOf('big.png', 100)]);

        expect2(() => service.completed[0].list[0].failure).toEqual({
            source: UPLOAD_FAILURE_SOURCE.api,
            code: UPLOAD_FAILURE_CODE.tooLarge,
            status: 413,
            reason: 'TOO LARGE',
            message: '6291456 > 4000000',
        });
        expect2(() => views[0].status).toEqual('failed');
    });

    it('aggregates progress by bytes: per-file sent, and one batch ratio', () => {
        const snapshots: UploadBatchProgress[] = [];
        const tracker = new UploadProgressTracker([100, 300], p => snapshots.push(p));

        tracker.sink(0)(50);
        tracker.sink(1)(150);
        // a late, smaller report never moves a file backwards
        tracker.sink(1)(10);
        tracker.settle(0);

        const last = snapshots[snapshots.length - 1];
        expect2(() => snapshots.length).toEqual(3);
        expect2(() => last.files.map(file => [file.sent, file.settled])).toEqual([
            [50, true],
            [150, false],
        ]);
        // settled counts its whole `total`, not its last report: (100 + 150) / 400
        expect2(() => [last.totalBytes, last.sentBytes, last.ratio]).toEqual([400, 250, 0.625]);
    });

    it('caps transfers in flight at the configured concurrency, keeping the result order', async () => {
        let inFlight = 0;
        let peak = 0;
        const send: InlineSendCall = async id => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise(resolve => setTimeout(resolve, 1));
            inFlight -= 1;
            return { id, status: UPLOAD_STATUS.stored };
        };
        const ids = ['a', 'b', 'c', 'd', 'e'];
        const service = new FakeUploadService(ids.map(ticketOf));
        const engine = new UploadEngine(service, [new InlineExecutor(send, toBase64)], { concurrency: 2 });

        const views = await engine.upload(ids.map(id => sourceOf(`${id}.png`, 10)));

        expect2(() => peak).toEqual(2);
        expect2(() => views.map(view => view.id)).toEqual(ids);
    });

    it('contains an executor that throws to its own slot', async () => {
        const flaky: UploadTransferExecutor = {
            kind: UPLOAD_TRANSFER_KIND.inline,
            run: async id => {
                if (id === 'up-002') throw new Error('Network request failed');
                return { id };
            },
        };
        const service = new FakeUploadService([ticketOf('up-002'), ticketOf('up-004')]);
        const engine = new UploadEngine(service, [flaky]);

        const views = await engine.upload([sourceOf('a.png', 100), sourceOf('b.png', 300)]);

        expect2(() => service.completed[0].list).toEqual([
            {
                id: 'up-002',
                failure: {
                    source: UPLOAD_FAILURE_SOURCE.client,
                    code: UPLOAD_FAILURE_CODE.unknown,
                    message: 'Network request failed',
                },
            },
            { id: 'up-004' },
        ]);
        expect2(() => views.map(view => view.status)).toEqual(['failed', 'stored']);
    });

    it('sends the thumbnail when the ticket carries only `thumbnailTransfer` (a stored upload taking a preview)', async () => {
        const service = new FakeUploadService([SAMPLE_UPLOAD_TICKET_THUMBNAIL_ONLY]);
        const puts: string[] = [];
        const put: RawPut = async url => {
            puts.push(url);
            return { status: 200 };
        };
        const engine = new UploadEngine(service, [new PresignedPutExecutor(put)]);

        await engine.upload([{ ...sourceOf('photo.png', 1000), thumbnail: contentOf(200) }]);

        // the original's bytes are immutable, so only the thumbnail moves
        expect2(() => puts.length).toEqual(1);
        expect2(() => puts[0].indexOf('up-001-thumb') > 0).toEqual(true);
        // and the slot is still confirmed through complete, without a failure
        expect2(() => service.completed[0].list).toEqual([{ id: 'up-001' }]);
    });

    it('never fails the upload when the thumbnail transfer throws', async () => {
        const service = new FakeUploadService([SAMPLE_UPLOAD_TICKET_THUMBNAIL_ONLY]);
        const put: RawPut = async () => {
            throw new Error('thumbnail put exploded');
        };
        const engine = new UploadEngine(service, [new PresignedPutExecutor(put)]);

        const uploads = await engine.upload([{ ...sourceOf('photo.png', 1000), thumbnail: contentOf(200) }]);

        expect2(() => service.completed[0].list).toEqual([{ id: 'up-001' }]);
        expect2(() => uploads.map(upload => upload.status)).toEqual(['stored']);
    });

    it('counts thumbnail bytes in the batch total so the bar is not full while bytes still move', async () => {
        const service = new FakeUploadService([SAMPLE_UPLOAD_TICKET_THUMBNAIL_ONLY]);
        // report the whole body at once so the sink sees a real intermediate value
        const put: RawPut = async (_url, _headers, _body, onProgress) => {
            if (onProgress) onProgress(1, 1);
            return { status: 200 };
        };
        const engine = new UploadEngine(service, [new PresignedPutExecutor(put)]);
        const snapshots: UploadBatchProgress[] = [];

        await engine.upload([{ ...sourceOf('photo.png', 1000), thumbnail: contentOf(200) }], p => snapshots.push(p));

        expect2(() => snapshots[0].totalBytes).toEqual(1200);
        const last = snapshots[snapshots.length - 1];
        expect2(() => [last.sentBytes, last.ratio]).toEqual([1200, 1]);
    });

    it('leaves a source without a thumbnail exactly as it was', async () => {
        const service = new FakeUploadService([ticketOf('up-002')]);
        const engine = new UploadEngine(service, [new InlineExecutor(sendOk(), toBase64)]);
        const snapshots: UploadBatchProgress[] = [];

        const uploads = await engine.upload([sourceOf('a.png', 100)], p => snapshots.push(p));

        expect2(() => service.started[0].list).toEqual([
            { name: 'a.png', contentType: 'image/png', contentSize: 100 },
        ]);
        expect2(() => service.completed[0].list).toEqual([{ id: 'up-002' }]);
        expect2(() => uploads.map(upload => upload.status)).toEqual(['stored']);
        expect2(() => [snapshots[0].totalBytes, snapshots[snapshots.length - 1].ratio]).toEqual([100, 1]);
    });
});
