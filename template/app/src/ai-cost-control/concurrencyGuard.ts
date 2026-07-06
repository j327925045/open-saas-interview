import { prisma } from "wasp/server";
import { CONCURRENCY } from "./constants";

/**
 * Prevents a user from having multiple simultaneous AI operations.
 * Uses a database row as a distributed lock.
 */
export async function acquireConcurrencyLock(
  userId: string,
): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONCURRENCY.LOCK_TTL_MS);

  // Clean up stale locks first
  await prisma.concurrencyLock.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  try {
    await prisma.concurrencyLock.create({
      data: {
        id: `concurrent:${userId}`,
        userId,
        lockedAt: now,
        expiresAt,
      },
    });
    return true;
  } catch {
    // Unique constraint violation — another request is in progress
    return false;
  }
}

export async function releaseConcurrencyLock(userId: string): Promise<void> {
  try {
    await prisma.concurrencyLock.delete({
      where: { userId },
    });
  } catch {
    // Lock may have expired; ignore
  }
}
