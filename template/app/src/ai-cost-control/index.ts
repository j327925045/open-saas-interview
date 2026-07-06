import type { User } from "wasp/entities";
import { HttpError } from "wasp/server";
import { acquireConcurrencyLock, releaseConcurrencyLock } from "./concurrencyGuard";
import { checkIdempotency, saveIdempotencyResult } from "./idempotency";
import { checkQuota, quotaError } from "./quotaEnforcer";
import { checkRateLimit } from "./rateLimiter";
import { estimateCost, logAiUsage } from "./usageLogger";

export { logAiUsage, estimateCost, acquireConcurrencyLock, releaseConcurrencyLock };

/**
 * Wraps an AI operation with all abuse controls:
 * 1. Idempotency check (if idempotencyKey provided)
 * 2. Quota check (daily/monthly token limits)
 * 3. Rate limit check (requests per hour)
 * 4. Concurrency guard (one active AI call per user)
 * 5. Usage logging (record every call result)
 *
 * Returns the operation result, or throws HttpError with appropriate status code.
 */
export async function withAiCostControl<T>(
  user: User,
  operationName: string,
  operation: () => Promise<{ result: T; inputTokens: number; outputTokens: number }>,
  options?: {
    idempotencyKey?: string;
    ipAddress?: string;
    skipConcurrencyCheck?: boolean;
  },
): Promise<T> {
  const startTime = Date.now();

  // 1. Idempotency check
  if (options?.idempotencyKey) {
    const { isDuplicate, cachedResult } = await checkIdempotency<T>(
      options.idempotencyKey,
    );
    if (isDuplicate) {
      await logAiUsage({
        userId: user.id,
        operation: operationName,
        status: "denied_duplicate",
        idempotencyKey: options.idempotencyKey,
        ipAddress: options.ipAddress,
      });
      // Return cached result transparently instead of throwing
      return cachedResult!;
    }
  }

  // 2. Rate limit check
  const rateLimitResult = await checkRateLimit(user);
  if (!rateLimitResult.allowed) {
    await logAiUsage({
      userId: user.id,
      operation: operationName,
      status: "denied_rate_limit",
      durationMs: Date.now() - startTime,
      idempotencyKey: options?.idempotencyKey,
      ipAddress: options?.ipAddress,
    });
    throw new HttpError(429, rateLimitResult.reason!);
  }

  // 3. Quota check
  const quotaResult = await checkQuota(user);
  if (!quotaResult.allowed) {
    await logAiUsage({
      userId: user.id,
      operation: operationName,
      status: "denied_quota",
      durationMs: Date.now() - startTime,
      idempotencyKey: options?.idempotencyKey,
      ipAddress: options?.ipAddress,
    });
    throw quotaError(quotaResult);
  }

  // 4. Concurrency guard
  let hasLock = false;
  if (!options?.skipConcurrencyCheck) {
    hasLock = await acquireConcurrencyLock(user.id);
    if (!hasLock) {
      await logAiUsage({
        userId: user.id,
        operation: operationName,
        status: "denied_concurrent",
        durationMs: Date.now() - startTime,
        idempotencyKey: options?.idempotencyKey,
        ipAddress: options?.ipAddress,
      });
      throw new HttpError(
        429,
        "You already have an AI operation in progress. Please wait for it to complete.",
      );
    }
  }

  try {
    // 5. Execute the actual operation
    const { result, inputTokens, outputTokens } = await operation();
    const durationMs = Date.now() - startTime;
    const costUsd = estimateCost(inputTokens, outputTokens);

    // 6. Log success
    await logAiUsage({
      userId: user.id,
      operation: operationName,
      status: "success",
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      idempotencyKey: options?.idempotencyKey,
      ipAddress: options?.ipAddress,
    });

    // 7. Save idempotency result
    if (options?.idempotencyKey) {
      await saveIdempotencyResult(options.idempotencyKey, result);
    }

    return result;
  } catch (error) {
    // Log errors that are not HttpError (e.g. OpenAI API failure)
    if (!(error instanceof HttpError) || (error as HttpError).statusCode !== 429) {
      const durationMs = Date.now() - startTime;
      await logAiUsage({
        userId: user.id,
        operation: operationName,
        status: "error",
        durationMs,
        errorMessage: error instanceof Error ? error.message : String(error),
        idempotencyKey: options?.idempotencyKey,
        ipAddress: options?.ipAddress,
      });
    }
    throw error;
  } finally {
    // Release concurrency lock
    if (hasLock) {
      await releaseConcurrencyLock(user.id).catch(() => {});
    }
  }
}
