import { analyticsTracker } from './analytics-tracker';

/**
 * Retry Handler — Wraps async functions with exponential backoff and jitter.
 * Handles rate-limit (429) responses, transient failures, and network errors.
 */

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    retryOn?: (error: any) => boolean;       // Return true to retry
    retryLimitFor?: (error: any) => number;  // Per-error retry cap (overrides maxRetries)
    onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
};

function isTransientError(err: any): boolean {
    if (!err) return false;
    const status = err.status || err.statusCode || err.response?.status;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    const msg = String(err.message || err).toLowerCase();
    if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('etimedout')) return true;
    if (msg.includes('socket hang up') || msg.includes('network') || msg.includes('fetch failed')) return true;
    return false;
}

function getRetryAfterMs(err: any): number | null {
    const headers = err.response?.headers || err.headers;
    if (!headers) return null;
    const val = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
    if (!val) return null;
    const seconds = parseFloat(val);
    if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    const date = Date.parse(val);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
    return null;
}

/**
 * Provider response-parsing failures (malformed JSON in the model reply —
 * typically a truncated tool-call arguments string). These are retryable but
 * only once: the same turn is re-requested, never more.
 */
export function isProviderParseError(err: any): boolean {
    if (!err) return false;
    if (err?.code === 'TOOL_ARGUMENTS_JSON_PARSE') return true;
    const msg = String(err?.message || err).toLowerCase();
    return /unterminated string in json|unexpected (token|end of json input|non-whitespace character|number)|invalid json|json\.parse|expected (property name|double-quoted property name)/.test(msg);
}

function jitter(delayMs: number): number {
    return delayMs + Math.random() * delayMs * 0.3;
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts?: Partial<RetryOptions>
): Promise<T> {
    const options: RetryOptions = { ...DEFAULT_OPTIONS, ...opts };
    let lastError: any;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;

            const retryCap = options.retryLimitFor ? options.retryLimitFor(err) : options.maxRetries;
            if (attempt >= retryCap) break;

            const shouldRetry = options.retryOn
                ? options.retryOn(err)
                : isTransientError(err);

            if (!shouldRetry) break;

            // Calculate delay
            const retryAfter = getRetryAfterMs(err);
            const exponentialDelay = Math.min(
                options.baseDelayMs * Math.pow(2, attempt),
                options.maxDelayMs
            );
            const delayMs = retryAfter
                ? Math.min(retryAfter, options.maxDelayMs)
                : jitter(exponentialDelay);

            if (options.onRetry) {
                options.onRetry(attempt + 1, err, delayMs);
            } else {
                console.warn(`[RetryHandler] Attempt ${attempt + 1}/${options.maxRetries} failed, retrying in ${Math.round(delayMs)}ms: ${err.message || err}`);
            }

            // Record the retry event
            try {
                analyticsTracker.record({
                    type: 'tool_call',
                    metadata: { toolName: '_retry', attempt: attempt + 1, error: String(err.message || err).slice(0, 200) }
                });
            } catch { /* ignore */ }

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }

    throw lastError;
}

/**
 * Convenience wrapper for model.generate() with retry.
 *
 * Transient failures (429/5xx/network) retry up to 3 times. Provider
 * response-parsing failures (malformed JSON, e.g. an unterminated tool-call
 * arguments string) retry the SAME model turn at most ONCE, then surface as a
 * controlled provider error.
 */
export interface ModelRetryOptions {
    maxRetries?: number;
    retryOn?: (error: any) => boolean;
}

export function withModelRetry<T>(fn: () => Promise<T>, label?: string, opts?: ModelRetryOptions): Promise<T> {
    const maxRetries = opts?.maxRetries ?? 3;
    return withRetry(fn, {
        maxRetries,
        baseDelayMs: 2000,
        maxDelayMs: 60000,
        retryOn: opts?.retryOn ?? ((err: any) => isTransientError(err) || isProviderParseError(err)),
        retryLimitFor: (err: any) => (isProviderParseError(err) ? 1 : maxRetries),
        onRetry: (attempt, err, delayMs) => {
            console.warn(`[${label || 'ModelRetry'}] Attempt ${attempt}/${maxRetries} failed (${err.message || err}), retrying in ${Math.round(delayMs / 1000)}s...`);
        }
    });
}
