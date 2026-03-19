import { useEffect, useState, useCallback } from "react";
import { fetchAuditLog, type AuditEntry } from "../lib/api";

const PAGE_SIZE = 25;

const routingColors: Record<string, string> = {
  escalate_now: "bg-red-100 text-red-800",
  human_review: "bg-yellow-100 text-yellow-800",
  log_only: "bg-blue-50 text-blue-700",
  pass: "bg-green-50 text-green-700",
};

const routingOptions = ["", "escalate_now", "human_review", "log_only", "pass"];

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [routingFilter, setRoutingFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAuditLog({
        page,
        pageSize: PAGE_SIZE,
        routing_decision: routingFilter || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      });
      setEntries(data.entries);
      setTotal(data.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [page, routingFilter, fromDate, toDate]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [routingFilter, fromDate, toDate]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-6">
      <h1 className="mb-6 text-xl font-semibold">Audit Log</h1>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Routing Decision
          </label>
          <select
            value={routingFilter}
            onChange={(e) => setRoutingFilter(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {routingOptions.map((o) => (
              <option key={o} value={o}>
                {o || "All"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <span className="pb-1.5 text-xs text-gray-400">
          {total} entries
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-xs uppercase text-gray-400">
              <th className="px-4 py-2">Timestamp</th>
              <th className="px-4 py-2">Session ID</th>
              <th className="px-4 py-2">Decision</th>
              <th className="px-4 py-2">Flags</th>
              <th className="px-4 py-2">High Conf.</th>
              <th className="px-4 py-2">Categories</th>
              <th className="px-4 py-2">Latency</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  No audit log entries found.
                </td>
              </tr>
            )}
            {!loading &&
              entries.map((e, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-2 text-xs">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{e.session_id}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                        routingColors[e.routing_decision] ?? ""
                      }`}
                    >
                      {e.routing_decision}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {e.total_flags}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {e.high_confidence_flags}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {e.categories_flagged.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {e.annotation_latency_ms}ms
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
