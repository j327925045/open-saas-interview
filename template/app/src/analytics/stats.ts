import type { DailyStats } from "wasp/entities";

export type DailyStatsProps = {
  dailyStats?: DailyStats;
  weeklyStats?: DailyStats[];
  isLoading?: boolean;
};

export const calculateDailyStatsJob = async (_args: unknown, _context: unknown) => {
  console.log("Daily stats job is disabled (SQLite dev mode)");
};
