import { useState } from "react";
import { useAuth } from "wasp/client/auth";
import { useQuery } from "wasp/client/operations";
import { getAiUsageSummary, getAiUsageLogs } from "wasp/client/operations";
import { DefaultLayout } from "../../layout/DefaultLayout";

export default function AiUsageDashboardPage() {
  const { data: user } = useAuth();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");

  const { data: summary, isLoading: summaryLoading } = useQuery(getAiUsageSummary);
  const { data: logsData, isLoading: logsLoading } = useQuery(getAiUsageLogs, {
    skip: page * 20,
    status: statusFilter || undefined,
  });

  const logs = logsData?.logs ?? [];
  const totalPages = logsData?.totalPages ?? 1;

  return (
    <DefaultLayout user={user!}>
      <div className="p-6">
        <h1 className="mb-6 text-3xl font-bold">AI Usage & Cost Control</h1>

        {/* Summary Cards */}
        {summaryLoading ? (
          <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-card animate-pulse rounded-lg border p-4">
                <div className="bg-muted mb-2 h-4 w-20 rounded" />
                <div className="bg-muted h-8 w-32 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-4">
            <div className="bg-card rounded-lg border p-4">
              <p className="text-muted-foreground text-sm">Total Requests</p>
              <p className="text-2xl font-bold">{summary?.totalRequests ?? 0}</p>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <p className="text-muted-foreground text-sm">Success Rate</p>
              <p className="text-2xl font-bold">
                {summary?.totalRequests && summary.totalRequests > 0
                  ? `${Math.round(
                      ((summary.successfulRequests ?? 0) / summary.totalRequests) * 100,
                    )}%`
                  : "N/A"}
              </p>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <p className="text-muted-foreground text-sm">Total Cost</p>
              <p className="text-2xl font-bold">
                ${summary?.totalCost?.toFixed(4) ?? "0.0000"}
              </p>
            </div>
            <div className="bg-card rounded-lg border p-4">
              <p className="text-muted-foreground text-sm">Denied Requests</p>
              <p className="text-2xl font-bold">{summary?.deniedRequests ?? 0}</p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="mb-4 flex items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-sm">Status:</span>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(0);
              }}
              className="border-input bg-background rounded-md border px-3 py-1 text-sm"
            >
              <option value="">All</option>
              <option value="success">Success</option>
              <option value="denied_rate_limit">Rate Limited</option>
              <option value="denied_quota">Quota Exceeded</option>
              <option value="denied_duplicate">Duplicate</option>
              <option value="denied_concurrent">Concurrent</option>
              <option value="error">Error</option>
            </select>
          </label>
        </div>

        {/* Usage Log Table */}
        <div className="bg-card rounded-lg border">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Operation</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Tokens</th>
                  <th className="px-4 py-3 font-medium">Cost</th>
                  <th className="px-4 py-3 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {logsLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center">
                      Loading...
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted-foreground px-4 py-8 text-center">
                      No usage logs found.
                    </td>
                  </tr>
                ) : (
                  logs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-accent/50 border-b">
                      <td className="px-4 py-2">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="max-w-[120px] truncate px-4 py-2 font-mono text-xs">
                        {log.userEmail ?? log.userId.slice(0, 8)}
                      </td>
                      <td className="px-4 py-2">{log.operation}</td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            log.status === "success"
                              ? "bg-green-100 text-green-800"
                              : log.status === "error"
                                ? "bg-red-100 text-red-800"
                                : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {log.status}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {log.inputTokens + log.outputTokens > 0
                          ? `${log.inputTokens + log.outputTokens} (in:${log.inputTokens}/out:${log.outputTokens})`
                          : "-"}
                      </td>
                      <td className="px-4 py-2">
                        {log.costUsd > 0 ? `$${log.costUsd.toFixed(6)}` : "-"}
                      </td>
                      <td className="px-4 py-2">
                        {log.durationMs > 0 ? `${log.durationMs}ms` : "-"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3">
              <button
                disabled={page <= 0}
                onClick={() => setPage(page - 1)}
                className="border-input hover:bg-accent rounded-md border px-3 py-1 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm">
                Page {page + 1} of {totalPages}
              </span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
                className="border-input hover:bg-accent rounded-md border px-3 py-1 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </DefaultLayout>
  );
}
