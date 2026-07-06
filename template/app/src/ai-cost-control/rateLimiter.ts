import { prisma } from "wasp/server";
import type { User } from "wasp/entities";
import { RATE_LIMIT, ACTIVE_SUBSCRIPTION_STATUSES } from "./constants";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  reason?: string;
};

export async function checkRateLimit(
  user: User,
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT.WINDOW_MS);

  const isSubscribed = ACTIVE_SUBSCRIPTION_STATUSES.includes(
    user.subscriptionStatus ?? "",
  );
  const maxRequests = isSubscribed
    ? RATE_LIMIT.SUBSCRIBED_REQUESTS_PER_HOUR
    : RATE_LIMIT.FREE_REQUESTS_PER_HOUR;

  // Count successful requests in the current sliding window
  const count = await prisma.aiUsageLog.count({
    where: {
      userId: user.id,
      operation: "generateGptResponse",
      status: "success",
      createdAt: { gte: windowStart },
    },
  });

  const remaining = Math.max(0, maxRequests - count);
  const resetMs = RATE_LIMIT.WINDOW_MS;

  if (count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetMs,
      reason: `Rate limit exceeded. Max ${maxRequests} requests per hour. Try again later.`,
    };
  }

  return { allowed: true, remaining, resetMs };
}
