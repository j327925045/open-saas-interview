import { HttpError, prisma } from "wasp/server";
import type {
  GetAiUsageSummary,
  GetAiUsageLogs,
} from "wasp/server/operations";

type UsageSummary = {
  totalRequests: number;
  successfulRequests: number;
  deniedRequests: number;
  totalCost: number;
  totalTokens: number;
  uniqueUsers: number;
};

export const getAiUsageSummary: GetAiUsageSummary<void, UsageSummary> = async (
  _args,
  context,
) => {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Only admins can view usage summary");
  }

  const [
    totalRequests,
    successfulRequests,
    totalCostAgg,
    totalTokensAgg,
    uniqueUsers,
  ] = await Promise.all([
    prisma.aiUsageLog.count(),
    prisma.aiUsageLog.count({ where: { status: "success" } }),
    prisma.aiUsageLog.aggregate({
      _sum: { costUsd: true },
      where: { status: "success" },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { inputTokens: true, outputTokens: true },
      where: { status: "success" },
    }),
    prisma.aiUsageLog.groupBy({
      by: ["userId"],
      _count: { userId: true },
    }),
  ]);

  const deniedCount = await prisma.aiUsageLog.count({
    where: {
      status: { startsWith: "denied_" },
    },
  });

  return {
    totalRequests,
    successfulRequests,
    deniedRequests: deniedCount,
    totalCost: totalCostAgg._sum.costUsd ?? 0,
    totalTokens:
      (totalTokensAgg._sum.inputTokens ?? 0) +
      (totalTokensAgg._sum.outputTokens ?? 0),
    uniqueUsers: uniqueUsers.length,
  };
};

type AiUsageLogsInput = {
  skip: number;
  status?: string;
};

type AiUsageLogsOutput = {
  logs: Array<{
    id: string;
    createdAt: Date;
    userId: string;
    userEmail?: string | null;
    operation: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    durationMs: number;
    errorMessage?: string | null;
  }>;
  totalPages: number;
};

export const getAiUsageLogs: GetAiUsageLogs<
  AiUsageLogsInput,
  AiUsageLogsOutput
> = async (args, context) => {
  if (!context.user?.isAdmin) {
    throw new HttpError(403, "Only admins can view usage logs");
  }

  const pageSize = 20;
  const where: any = {};
  if (args.status) {
    where.status = args.status;
  }

  const [logs, total] = await Promise.all([
    prisma.aiUsageLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: args.skip ?? 0,
      take: pageSize,
    }),
    prisma.aiUsageLog.count({ where }),
  ]);

  // Enrich with user emails
  const userIds = [...new Set(logs.map((l) => l.userId))];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u.email]));

  return {
    logs: logs.map((log) => ({
      id: log.id,
      createdAt: log.createdAt,
      userId: log.userId,
      userEmail: userMap.get(log.userId) ?? null,
      operation: log.operation,
      status: log.status,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      costUsd: log.costUsd,
      durationMs: log.durationMs,
      errorMessage: log.errorMessage,
    })),
    totalPages: Math.ceil(total / pageSize),
  };
};
