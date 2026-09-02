export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type AppErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "needs_slot"
  | "invalid_external_data"
  | "unavailable_product"
  | "cart_validation_error"
  | "partial_commit"
  | "model_invalid_output"
  | "unexpected";

export interface AppError {
  code: AppErrorCode;
  message: string;
  correlationId: string;
  retryAfterMs: number | null;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
