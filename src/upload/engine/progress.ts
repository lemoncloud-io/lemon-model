/**
 * `upload/engine/progress.ts`
 * - progress is a CLIENT-LOCAL signal: nothing here travels on the wire and no server ever sees it.
 *   the server's knowledge of progress differs per transfer kind (a presigned PUT it cannot see at all),
 *   so the contract deliberately carries none of it.
 * - scope A: per-file percent + one batch percent. everything is measured in bytes of the ORIGINAL
 *   content, never in wire bytes, so the bar means the same thing whichever executor runs.
 *
 * @copyright (C) 2026 LemonCloud Co Ltd. - All Rights Reserved.
 */

/** bytes of the ORIGINAL send sent so far for one file. called 0..n times; never after run() settles */
export type UploadProgressSink = (sent: number) => void;

/** what an HTTP primitive can observe: request-body bytes (`XMLHttpRequest.upload.onprogress`). fetch never calls it */
export type UploadWireProgress = (loaded: number, total: number) => void;

/** scale request-body progress (base64 JSON or raw bytes) to original-send bytes */
export const asContentBytes = (loaded: number, total: number, contentSize: number): number =>
    total > 0 ? Math.min(contentSize, Math.round((loaded / total) * contentSize)) : 0;

/** progress of one file in the batch; `index` matches the `sources` array (exists before any server id does) */
export interface UploadFileProgress {
    index: number;
    /** original send bytes — known before `start` */
    total: number;
    /** bytes reported by the executor; undefined until the first report = indeterminate */
    sent?: number;
    /** the slot is done for the bar's purpose: stored, failed, rejected at start, or dedup */
    settled: boolean;
}

export interface UploadBatchProgress {
    files: ReadonlyArray<UploadFileProgress>;
    /** sum of `total` — fixed for the whole batch so the bar never moves backwards */
    totalBytes: number;
    /** sum of (settled ? total : sent ?? 0) */
    sentBytes: number;
    /** sentBytes / totalBytes in [0, 1]; when totalBytes is 0, settled files / all files */
    ratio: number;
}

export type UploadBatchProgressSink = (progress: UploadBatchProgress) => void;

/** byte-weighted aggregation; one immutable snapshot per change so a UI store can replace state as-is */
export class UploadProgressTracker {
    private files: UploadFileProgress[];
    private readonly totalBytes: number;

    public constructor(totals: ReadonlyArray<number>, private readonly emit?: UploadBatchProgressSink) {
        this.files = totals.map((total, index) => ({ index, total: Math.max(0, total), settled: false }));
        this.totalBytes = this.files.reduce((sum, file) => sum + file.total, 0);
    }

    /** the per-file sink handed to an executor: clamps to [previous, total], ignores reports after settle */
    public sink(index: number): UploadProgressSink {
        return sent => {
            const file = this.files[index];
            if (!file || file.settled) return;
            const next = Math.min(file.total, Math.max(sent, file.sent ?? 0));
            if (next === file.sent) return;
            this.files = this.files.map(item => (item.index === index ? { ...item, sent: next } : item));
            this.publish();
        };
    }

    public settle(index: number): void {
        const file = this.files[index];
        if (!file || file.settled) return;
        this.files = this.files.map(item => (item.index === index ? { ...item, settled: true } : item));
        this.publish();
    }

    public snapshot(): UploadBatchProgress {
        const sentBytes = this.files.reduce((sum, file) => sum + (file.settled ? file.total : file.sent ?? 0), 0);
        const settled = this.files.filter(file => file.settled).length;
        const ratio =
            this.totalBytes > 0 ? sentBytes / this.totalBytes : this.files.length > 0 ? settled / this.files.length : 1;
        return { files: this.files, totalBytes: this.totalBytes, sentBytes, ratio };
    }

    public publish(): void {
        if (this.emit) this.emit(this.snapshot());
    }
}
