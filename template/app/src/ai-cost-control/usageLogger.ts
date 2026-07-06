import { prisma } from "wasp/server";

export type UsageLogInput = {
  userId: string;
  operation: string;
  status: "success" | "denied_rate_limit" | "denied_quota" | "denied_duplicate" | "denied_concurrent" | "error";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  idempotencyKey?: string;
  errorMessage?: string;
  ipAddress?: string;
};

export async function logAiUsage(input: UsageLogInput): Promise<void> {
  await prisma.aiUsageLog.create({
    data: {
      userId: input.userId,
      operation: input.operation,
      status: input.status,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      costUsd: input.costUsd ?? 0,
      durationMs: input.durationMs ?? 0,
      idempotencyKey: input.idempotencyKey,
      errorMessage: input.errorMessage,
      ipAddress: input.ipAddress,
    },
  });
}

// Estimate cost based on token counts
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
): number {
  // GPT-3.5-turbo pricing
  const inputCost = (inputTokens / 1000) * 0.0015;
  const outputCost = (outputTokens / 1000) * 0.002;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // round to micro-dollar precision
}
