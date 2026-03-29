import { logger } from './logger';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Retry with Exponential Backoff
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  label?: string;
  /** Return true for errors that should NOT be retried */
  isNonRetryable?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: any;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      /* Non-retryable errors */
      if (config.isNonRetryable?.(error)) {
        throw error;
      }

      if (attempt >= config.maxRetries) break;

      /* Exponential backoff with jitter */
      const baseDelay = config.baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * config.baseDelayMs;
      const delay = Math.min(baseDelay + jitter, config.maxDelayMs ?? 30_000);

      const status = error?.response?.status;
      const isRateLimit = status === 429;

      logger.warn(
        {
          label: config.label ?? 'retry',
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          delayMs: Math.round(delay),
          status,
          rateLimit: isRateLimit,
        },
        `Retry: attempt ${attempt + 1}/${config.maxRetries} — waiting ${Math.round(delay)}ms`,
      );

      /* If rate limited, use server's Retry-After header if available */
      if (isRateLimit) {
        const retryAfter = parseInt(error?.response?.headers?.['retry-after'] ?? '0', 10);
        if (retryAfter > 0) {
          await sleep(retryAfter * 1000);
          continue;
        }
      }

      await sleep(delay);
    }
  }

  logger.error(
    { label: config.label ?? 'retry', maxRetries: config.maxRetries },
    'All retry attempts exhausted',
  );
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}