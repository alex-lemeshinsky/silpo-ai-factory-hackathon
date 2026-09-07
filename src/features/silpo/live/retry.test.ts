import { describe, expect, it, vi } from "vitest";

import {
  computeRetryDelayMs,
  isRetryableStatus,
  RETRY_ATTEMPT_LIMIT,
  withBoundedRetry,
} from "./retry";

const noJitter = () => 0;

describe("computeRetryDelayMs", () => {
  it("uses the 250/500/1000 ladder when no Retry-After is present", () => {
    const delays = [1, 2, 3].map((attempt) =>
      computeRetryDelayMs({
        attempt,
        retryAfterHeader: null,
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    );
    expect(delays).toEqual([250, 500, 1000]);
  });

  it("adds bounded jitter above the base delay", () => {
    const delay = computeRetryDelayMs({
      attempt: 1,
      retryAfterHeader: null,
      remainingDeadlineMs: 60_000,
      jitter: () => 0.5,
    });
    expect(delay).toBeGreaterThan(250);
    expect(delay).toBeLessThanOrEqual(250 + 250);
  });

  it("prefers server-provided Retry-After seconds", () => {
    expect(
      computeRetryDelayMs({
        attempt: 1,
        retryAfterHeader: "2",
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    ).toBe(2000);
  });

  it("ignores a malformed or negative Retry-After and falls back to the ladder", () => {
    for (const header of ["soon", "-5", ""]) {
      expect(
        computeRetryDelayMs({
          attempt: 1,
          retryAfterHeader: header,
          remainingDeadlineMs: 60_000,
          jitter: noJitter,
        }),
      ).toBe(250);
    }
  });

  it("returns null when the delay cannot fit the remaining deadline", () => {
    expect(
      computeRetryDelayMs({
        attempt: 1,
        retryAfterHeader: "30",
        remainingDeadlineMs: 1_000,
        jitter: noJitter,
      }),
    ).toBeNull();
  });

  it("returns null once the attempt limit is exceeded", () => {
    expect(
      computeRetryDelayMs({
        attempt: RETRY_ATTEMPT_LIMIT + 1,
        retryAfterHeader: null,
        remainingDeadlineMs: 60_000,
        jitter: noJitter,
      }),
    ).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  it("retries only 429", () => {
    expect(isRetryableStatus(429)).toBe(true);
    for (const status of [200, 400, 401, 403, 500, 503]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

describe("withBoundedRetry", () => {
  const classifyRateLimited = (error: unknown) => ({
    retryable: error instanceof Error && error.message === "429",
    retryAfterHeader: null,
  });

  it("returns the first successful result without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => "ok");

    const result = await withBoundedRetry(operation, {
      deadlineAt: 60_000,
      now: () => 0,
      sleep,
      classify: classifyRateLimited,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a rate-limited operation and returns the eventual success", async () => {
    const sleep = vi.fn(async (ms: number) => {
      void ms;
    });
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("429");
      return "ok";
    });

    const result = await withBoundedRetry(operation, {
      deadlineAt: 60_000,
      now: () => 0,
      sleep,
      classify: classifyRateLimited,
      jitter: noJitter,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
  });

  it("gives up after exactly three retries and rethrows the last error", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("429");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 60_000,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
        jitter: noJitter,
      }),
    ).rejects.toThrow("429");

    expect(operation).toHaveBeenCalledTimes(RETRY_ATTEMPT_LIMIT + 1);
    expect(sleep).toHaveBeenCalledTimes(RETRY_ATTEMPT_LIMIT);
  });

  it("never retries an error the classifier rejects", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("401");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 60_000,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
      }),
    ).rejects.toThrow("401");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops retrying when the deadline has passed", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => {
      throw new Error("429");
    });

    await expect(
      withBoundedRetry(operation, {
        deadlineAt: 100,
        now: () => 0,
        sleep,
        classify: classifyRateLimited,
        jitter: noJitter,
      }),
    ).rejects.toThrow("429");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
