export interface RetryNotice {
  label: string;
  attempt: number;
  maxAttempts: number;
  error: string;
  nextDelayMs: number;
}

export interface RetryOptions {
  label: string;
  maxAttempts: number;
  retryBackoffMs: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (notice: RetryNotice) => void;
}

export function errorMessageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

export function isRetryableNetworkError(error: unknown): boolean {
  const messages = errorMessageChain(error).join("\n");
  return /fetch failed|network|socket|econnreset|econnrefused|etimedout|eai_again|enotfound|temporarily unavailable|too many requests/i
    .test(messages) ||
    /\b(?:HTTP\s*)?(?:429|5\d\d)\b/i.test(messages);
}

export function retryDelayMs(baseDelayMs: number, attempt: number): number {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("Retry backoff must be a non-negative number.");
  }
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new Error("Retry attempt must be a positive number.");
  }
  return Math.round(baseDelayMs * (2 ** Math.max(0, Math.trunc(attempt) - 1)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("Retry max attempts must be a positive integer.");
  }
  if (!Number.isFinite(options.retryBackoffMs) || options.retryBackoffMs < 0) {
    throw new Error("Retry backoff must be a non-negative number.");
  }

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!options.isRetryable(error)) throw error;
      if (attempt === options.maxAttempts) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${options.label} failed after ${options.maxAttempts} attempts: ${message}`,
          { cause: error }
        );
      }
      const nextDelayMs = retryDelayMs(options.retryBackoffMs, attempt);
      options.onRetry?.({
        label: options.label,
        attempt,
        maxAttempts: options.maxAttempts,
        error: error instanceof Error ? error.message : String(error),
        nextDelayMs
      });
      await sleep(nextDelayMs);
    }
  }

  throw new Error(`${options.label} retry loop ended without a result.`);
}
