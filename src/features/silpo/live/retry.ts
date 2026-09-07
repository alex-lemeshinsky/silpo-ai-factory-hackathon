/**
 * Bounded retry policy for read-only Silpo MCP calls.
 *
 * Pure by construction: it knows about attempt counts, delays and deadlines,
 * and nothing about sessions, transports or MCP types. `oauth/transport.ts`
 * imports `computeRetryDelayMs` so the delay ladder is defined exactly once.
 *
 * Cart writes never reach this module — the write session has no retry path.
 */

export const RETRY_ATTEMPT_LIMIT = 3;
export const RETRY_BASE_DELAYS_MS = [250, 500, 1000] as const;

export interface RetryDelayInput {
  /** 1-based attempt number: the first retry is attempt 1. */
  attempt: number;
  retryAfterHeader: string | null;
  remainingDeadlineMs: number;
  /** Returns a value in [0, 1). Injectable so tests are deterministic. */
  jitter?: () => number;
}

/**
 * Returns the delay before the given retry attempt, or null when the caller
 * must stop: the attempt limit is exhausted, or the delay would outlive the
 * operation deadline. A server-supplied Retry-After never extends the
 * deadline; it only ends the loop sooner.
 */
export function computeRetryDelayMs(input: RetryDelayInput): number | null {
  const { attempt, retryAfterHeader, remainingDeadlineMs } = input;
  const jitter = input.jitter ?? Math.random;

  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RETRY_ATTEMPT_LIMIT) {
    return null;
  }

  const base = RETRY_BASE_DELAYS_MS[attempt - 1];
  let delay = base + jitter() * base;

  if (retryAfterHeader !== null && retryAfterHeader.trim().length > 0) {
    const seconds = Number.parseInt(retryAfterHeader.trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delay = seconds * 1000;
    }
  }

  if (delay > remainingDeadlineMs) {
    return null;
  }
  return delay;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429;
}

export interface RetryClassification {
  retryable: boolean;
  retryAfterHeader: string | null;
}

export interface BoundedRetryOptions {
  /** Absolute epoch-ms deadline for the whole operation. */
  deadlineAt: number;
  classify: (error: unknown) => RetryClassification;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  attemptLimit?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying only errors the classifier marks retryable, at
 * most `attemptLimit` times. The original error is rethrown when the budget
 * or the deadline is exhausted, so callers still see the real failure.
 */
export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: BoundedRetryOptions,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const attemptLimit = options.attemptLimit ?? RETRY_ATTEMPT_LIMIT;

  let attempt = 0;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attemptLimit) {
        throw error;
      }

      const classification = options.classify(error);
      if (!classification.retryable) {
        throw error;
      }

      attempt += 1;
      const delay = computeRetryDelayMs({
        attempt,
        retryAfterHeader: classification.retryAfterHeader,
        remainingDeadlineMs: options.deadlineAt - now(),
        jitter: options.jitter,
      });

      if (delay === null) {
        throw error;
      }
      await sleep(delay);
    }
  }
}
