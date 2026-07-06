import { prisma } from "wasp/server";
import { IDEMPOTENCY } from "./constants";

/**
 * Idempotency check: if the same idempotency key was already processed,
 * return the cached result to prevent duplicate AI calls.
 */
export async function checkIdempotency<T>(
  key: string,
): Promise<{ isDuplicate: boolean; cachedResult?: T }> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { id: key },
  });

  if (existing) {
    return {
      isDuplicate: true,
      cachedResult: JSON.parse(existing.result) as T,
    };
  }

  return { isDuplicate: false };
}

export async function saveIdempotencyResult<T>(
  key: string,
  result: T,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY.KEY_TTL_MS);

  await prisma.idempotencyRecord.create({
    data: {
      id: key,
      result: JSON.stringify(result),
      createdAt: now,
      expiresAt,
    },
  });
}
