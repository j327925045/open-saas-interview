import { query, type Spec } from "@wasp.sh/spec";

import { getDailyStats } from "./operations" with { type: "ref" };

export const analyticsSpec: Spec = [
  query(getDailyStats, { entities: ["User", "DailyStats"] }),
];
