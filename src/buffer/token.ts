/**
 * `buffer/token.ts`
 * - Legacy token-string buffering helper.
 *
 * @origin eureka-agents-api / src/lib/buffer/token.ts
 *
 * type: `TokenBufferOptions`
 */
export interface TokenBufferOptions {
    /** buffer flush strategy */
    flushStrategy?: 'time' | 'size';
    /** time-based flush interval in ms */
    bufferMs?: number;
    /** max tokens before force flush in time strategy */
    maxTokensForTime?: number;
    /** size-based flush when token count reaches this */
    bufferSize?: number;
    /** max wait time in ms for size strategy */
    maxWaitMs?: number;
    /** enable buffer (default: true) */
    useBuffer?: boolean;
}

/**
 * class: `TokenBuffer`
 * - manages token buffering with configurable flush strategies
 */
export class TokenBuffer {
    private tokens: string[] = [];
    private timer?: ReturnType<typeof setTimeout>;
    private isProcessing = false;
    private readonly options: Required<TokenBufferOptions>;

    constructor(private flushCallback: (content: string) => Promise<void>, options?: TokenBufferOptions) {
        this.options = {
            flushStrategy: options?.flushStrategy ?? 'size',
            bufferMs: options?.bufferMs ?? 300,
            maxTokensForTime: options?.maxTokensForTime ?? 30,
            bufferSize: options?.bufferSize ?? 10,
            maxWaitMs: options?.maxWaitMs ?? 300,
            useBuffer: options?.useBuffer ?? true,
        };
    }

    /**
     * add token to buffer
     */
    public async add(token: string): Promise<void> {
        if (!this.options.useBuffer) {
            await this.flushCallback(token);
            return;
        }

        this.tokens.push(token);

        if (this.options.flushStrategy === 'size') {
            // size 전략: 개수 도달하면 flush, 아니면 최대 대기시간 타이머
            if (this.tokens.length >= this.options.bufferSize) {
                await this.flush();
            } else {
                this.scheduleMaxWaitFlush();
            }
        } else {
            // time 전략: 일정 개수 되면 강제 flush, 아니면 시간 타이머
            if (this.tokens.length >= this.options.maxTokensForTime) {
                await this.flush();
            } else {
                this.scheduleTimeFlush();
            }
        }
    }

    /**
     * flush all buffered tokens
     */
    public async flush(): Promise<void> {
        if (this.isProcessing || this.tokens.length === 0) return;

        this.isProcessing = true;
        this.clearTimer();

        const content = this.tokens.join('');
        this.tokens = [];

        try {
            await this.flushCallback(content);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * close buffer and flush remaining tokens
     */
    public async close(): Promise<void> {
        await this.flush();
        this.clearTimer();
    }

    private scheduleTimeFlush(): void {
        if (this.timer) return;

        this.timer = setTimeout(async () => {
            await this.flush();
        }, this.options.bufferMs);
    }

    private scheduleMaxWaitFlush(): void {
        if (this.timer) return;

        this.timer = setTimeout(async () => {
            await this.flush();
        }, this.options.maxWaitMs);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
