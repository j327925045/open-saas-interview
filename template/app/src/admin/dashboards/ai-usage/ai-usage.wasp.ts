import { page, query, route, type Spec } from "@wasp.sh/spec";

import { AiUsageDashboardPage } from "./AiUsageDashboardPage" with { type: "ref" };
import { getAiUsageSummary, getAiUsageLogs } from "./operations" with { type: "ref" };

export const aiUsageAdminSpec: Spec = [
  route(
    "AdminAiUsageRoute",
    "/admin/ai-usage",
    page(AiUsageDashboardPage, { authRequired: true }),
  ),
  query(getAiUsageSummary, { entities: ["AiUsageLog", "User"] }),
  query(getAiUsageLogs, { entities: ["AiUsageLog", "User"] }),
];
