import type { User } from "wasp/entities";
import { HttpError, prisma } from "wasp/server";
import { ACTIVE_SUBSCRIPTION_STATUSES, QUOTA } from "./constants";

export type QuotaCheckResult = {
  allowed: boolean;
  reason?: string;
  dailyTokensUsed: number;
  monthlyTokensUsed: number;
  remainingDailyTokens: number;
};

export async function checkQuota(user: User): Promise<QuotaCheckResult> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const isSubscribed = ACTIVE_SUBSCRIPTION_STATUSES.includes(
    user.subscriptionStatus ?? "",
  );

  const dailyLimit = isSubscribed
    ? QUOTA.SUBSCRIBED_DAILY_TOKENS
    : QUOTA.FREE_DAILY_TOKENS;
  const monthlyLimit = isSubscribed
    ? QUOTA.SUBSCRIBED_MONTHLY_TOKENS
    : QUOTA.FREE_MONTHLY_TOKENS;

  // Aggregate token usage from logs
  const dailyAgg = await prisma.aiUsageLog.aggregate({
    _sum: { inputTokens: true, outputTokens: true },
    where: {
      userId: user.id,
      status: "success",
      createdAt: { gte: startOfDay },
    },
  });

  const monthlyAgg = await prisma.aiUsageLog.aggregate({
    _sum: { inputTokens: true, outputTokens: true },
    where: {
      userId: user.id,
      status: "success",
      createdAt: { gte: startOfMonth },
    },
  });

  const dailyTokensUsed =
    (dailyAgg._sum.inputTokens ?? 0) + (dailyAgg._sum.outputTokens ?? 0);
  const monthlyTokensUsed =
    (monthlyAgg._sum.inputTokens ?? 0) + (monthlyAgg._sum.outputTokens ?? 0);

  const remainingDailyTokens = Math.max(0, dailyLimit - dailyTokensUsed);
  const remainingMonthlyTokens = Math.max(0, monthlyLimit - monthlyTokensUsed);

  if (remainingDailyTokens <= 0) {
    return {
      allowed: false,
      reason: `Daily token quota exceeded (${dailyTokensUsed}/${dailyLimit}). Upgrade to a subscription for higher limits.`,
      dailyTokensUsed,
      monthlyTokensUsed,
      remainingDailyTokens: 0,
    };
  }

  if (remainingMonthlyTokens <= 0) {
    return {
      allowed: false,
      reason: `Monthly token quota exceeded (${monthlyTokensUsed}/${monthlyLimit}). Upgrade to a subscription for higher limits.`,
      dailyTokensUsed,
      monthlyTokensUsed,
      remainingDailyTokens,
    };
  }

  // Also check the existing credit-based system for non-subscribed users
  if (!isSubscribed && user.credits <= 0) {
    // But we still allow if they have daily quota remaining — credits are a
    // purchase/one-time thing while the token quota is a rate-based control.
    // We enforce credits separately in the main AI operation.
  }

  return {
    allowed: true,
    dailyTokensUsed,
    monthlyTokensUsed,
    remainingDailyTokens,
  };
}

export function quotaError(result: QuotaCheckResult): HttpError {
  return new HttpError(429, result.reason ?? "Quota exceeded");
}
