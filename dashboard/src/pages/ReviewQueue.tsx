import { useEffect, useState, useCallback } from "react";
import {
  fetchReviewQueue,
  submitVerdict,
  type ReviewQueueItem,
} from "../lib/api";
import FlagBadge from "../components/FlagBadge";
import VerdictButton from "../components/VerdictButton";

// ─── Annotation helpers ──────────────────────────────────────────────────────

interface FlagInfo {
  category: string;
  flag: string;
  confidence: string | null;
  evidence: string | null;
}

function extractFlags(annotations: Record<string, unknown>): FlagInfo[] {
  const flags: FlagInfo[] = [];
  const booleanFlags: Record<string, string[]> = {
    scope_integrity: [
      "diagnostic_language_detected",
      "treatment_recommendation_detected",
      "scope_exceeded",
    ],
    escalation_integrity: ["red_flag_detected"],
    input_boundary_integrity: ["out_of_scope_answer_attempted"],
    interaction_pattern_integrity: [
      "repeat_query_detected",
      "user_escalation_pattern",
      "unmet_needs_pattern",
    ],
  };

  // Check for escalation_present being false when red_flag_detected is true
  const esc = annotations.escalation_integrity as Record<string, unknown> | undefined;
  if (esc?.red_flag_detected === true && esc?.escalation_present === false) {
    flags.push({
      category: "escalation_integrity",
      flag: "escalation_missing",
      confidence: (esc.confidence as string) ?? null,
      evidence: (esc.evidence as string) ?? null,
    });
  }

  for (const [category, flagNames] of Object.entries(booleanFlags)) {
    const cat = annotations[category] as Record<string, unknown> | undefined;
    if (!cat) continue;
    for (const f of flagNames) {
      if (cat[f] === true) {
        flags.push({
          category,
          flag: f,
          confidence: (cat.confidence as string) ?? null,
          evidence: (cat.evidence as string) ?? null,
        });
      }
    }
  }
  return flags;
}

const categoryLabels: Record<string, string> = {
  scope_integrity: "Scope",
  escalation_integrity: "Escalation",
  input_boundary_integrity: "Input Boundary",
  interaction_pattern_integrity: "Interaction Pattern",
};

const failureCategoryMap: Record<string, string> = {
  scope_integrity: "scope",
  escalation_integrity: "escalation",
  input_boundary_integrity: "input_boundary",
  interaction_pattern_integrity: "interaction_pattern",
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ReviewQueue() {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Record<string, string>>({});
  const [expandedSpec, setExpandedSpec] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchReviewQueue();
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVerdict(
    item: ReviewQueueItem,
    verdict: "confirmed_failure" | "false_alarm" | "uncertain",
  ) {
    setSubmitting((s) => ({ ...s, [item.id]: verdict }));
    try {
      const flags = extractFlags(item.annotations);
      const primaryCategory = flags[0]
        ? failureCategoryMap[flags[0].category]
        : undefined;
      await submitVerdict(item.id, verdict, primaryCategory);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setTotal((t) => t - 1);
    } catch (e) {
      setError(`Failed to submit verdict: ${e}`);
    } finally {
      setSubmitting((s) => {
        const next = { ...s };
        delete next[item.id];
        return next;
      });
    }
  }

  if (loading) {
    return <p className="p-6 text-gray-500">Loading review queue...</p>;
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Review Queue</h1>
        <span className="text-sm text-gray-500">{total} pending</span>
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {items.length === 0 && !error && (
        <div className="rounded border border-gray-200 bg-white px-6 py-12 text-center text-gray-400">
          No interactions pending review.
        </div>
      )}

      <div className="space-y-4">
        {items.map((item) => {
          const flags = extractFlags(item.annotations);
          const isSubmitting = !!submitting[item.id];
          const specExpanded = !!expandedSpec[item.id];

          return (
            <div
              key={item.id}
              className="rounded border border-gray-200 bg-white"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
                <span>
                  Session: <span className="font-mono">{item.session_id}</span>
                </span>
                <span>{new Date(item.timestamp).toLocaleString()}</span>
              </div>

              {/* Interaction */}
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-gray-400">
                    User Message
                  </p>
                  <p className="text-sm leading-relaxed">{item.user_input}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-gray-400">
                    Agent Response
                  </p>
                  <p className="text-sm leading-relaxed">{item.agent_output}</p>
                </div>
              </div>

              {/* Flags */}
              <div className="border-t border-gray-100 px-4 py-3">
                <p className="mb-2 text-xs font-medium uppercase text-gray-400">
                  Triggered Flags
                </p>
                <div className="flex flex-wrap gap-2">
                  {flags.map((f, i) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <span className="text-[10px] text-gray-400">
                        {categoryLabels[f.category] ?? f.category}
                      </span>
                      <FlagBadge flag={f.flag} confidence={f.confidence} />
                      {f.evidence && (
                        <span className="mt-0.5 max-w-xs truncate text-[10px] italic text-gray-400">
                          "{f.evidence}"
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Risk scores */}
              {item.risk_scores && (
                <div className="border-t border-gray-100 px-4 py-3">
                  <p className="mb-2 text-xs font-medium uppercase text-gray-400">
                    Risk Scores
                  </p>
                  <div className="flex flex-wrap gap-4 text-xs">
                    {Object.entries(item.risk_scores).map(([cat, score]) => (
                      <span key={cat} className="font-mono">
                        <span className="text-gray-500">
                          {categoryLabels[cat] ?? cat}:
                        </span>{" "}
                        {(score as number).toFixed(3)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Boundary spec (collapsible) */}
              <div className="border-t border-gray-100 px-4 py-2">
                <button
                  className="text-xs text-blue-600 hover:text-blue-800"
                  onClick={() =>
                    setExpandedSpec((s) => ({
                      ...s,
                      [item.id]: !s[item.id],
                    }))
                  }
                >
                  {specExpanded ? "Hide" : "Show"} boundary spec
                </button>
                {specExpanded && (
                  <div className="mt-2 rounded bg-gray-50 p-3 text-xs">
                    <div className="mb-2">
                      <span className="font-medium">Permitted scope: </span>
                      {item.boundary_spec.permitted_scope}
                    </div>
                    <div className="mb-2">
                      <span className="font-medium">Escalation rules: </span>
                      {item.boundary_spec.escalation_rules.join("; ")}
                    </div>
                    <div className="mb-2">
                      <span className="font-medium">Prohibited actions: </span>
                      {item.boundary_spec.prohibited_actions.join("; ")}
                    </div>
                    <div>
                      <span className="font-medium">Language level: </span>
                      {item.boundary_spec.permitted_language_level}
                    </div>
                  </div>
                )}
              </div>

              {/* Verdict buttons */}
              <div className="flex items-center gap-2 border-t border-gray-100 px-4 py-3">
                <span className="mr-2 text-xs text-gray-500">Verdict:</span>
                {(
                  ["confirmed_failure", "false_alarm", "uncertain"] as const
                ).map((v) => (
                  <VerdictButton
                    key={v}
                    verdict={v}
                    disabled={isSubmitting}
                    active={submitting[item.id] === v}
                    onClick={() => handleVerdict(item, v)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
