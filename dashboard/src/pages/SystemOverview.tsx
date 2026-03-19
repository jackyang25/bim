import { useEffect, useState, useCallback } from "react";
import {
  fetchClassifierState,
  fetchHealth,
  fetchVerdictSummary,
  type ClassifierState,
  type HealthResponse,
  type VerdictSummary,
} from "../lib/api";
import BetaDistributionChart from "../components/BetaDistributionChart";
import RiskScoreBar from "../components/RiskScoreBar";

const categoryLabels: Record<string, string> = {
  scope: "Scope Integrity",
  escalation: "Escalation Integrity",
  input_boundary: "Input Boundary Integrity",
  interaction_pattern: "Interaction Pattern Integrity",
};

export default function SystemOverview() {
  const [classifier, setClassifier] = useState<ClassifierState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [verdictSummary, setVerdictSummary] = useState<VerdictSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [c, h, v] = await Promise.all([
        fetchClassifierState(),
        fetchHealth(),
        fetchVerdictSummary(),
      ]);
      setClassifier(c);
      setHealth(h);
      setVerdictSummary(v);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <p className="p-6 text-gray-500">Loading system overview...</p>;
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">System Overview</h1>

      {/* Health panel */}
      {health && (
        <div className="rounded border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase text-gray-400">
            Health
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Status" value={health.status} />
            <Stat label="Uptime" value={formatUptime(health.uptime_seconds)} />
            <Stat label="Model" value={health.model} />
            <Stat
              label="Rate Limit"
              value={`${health.rate_limit_remaining} remaining`}
            />
            <Stat label="Annotation Backend" value={health.annotation_backend} />
            <Stat label="Classifier Backend" value={health.classifier_backend} />
            <Stat label="Verdict Store" value={health.verdict_store} />
            <Stat
              label="API Key"
              value={health.api_key_configured ? "Configured" : "Missing"}
            />
          </div>
        </div>
      )}

      {/* Classifier state */}
      {classifier && (
        <>
          {/* Risk score bars */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase text-gray-400">
              Current Risk Scores
            </h2>
            <div className="space-y-2">
              {Object.entries(classifier.categories).map(([cat, state]) => (
                <RiskScoreBar
                  key={cat}
                  label={categoryLabels[cat] ?? cat}
                  score={state.posterior.mean}
                  thresholds={classifier.routing_thresholds}
                  isSafety={cat === "escalation"}
                />
              ))}
            </div>
          </div>

          {/* Beta distributions */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold uppercase text-gray-400">
              Beta Distributions
            </h2>
            <div className="grid gap-6 lg:grid-cols-2">
              {Object.entries(classifier.categories).map(([cat, state]) => (
                <BetaDistributionChart
                  key={cat}
                  alpha={state.posterior.alpha}
                  beta={state.posterior.beta}
                  label={categoryLabels[cat] ?? cat}
                  thresholds={classifier.routing_thresholds}
                  isSafety={cat === "escalation"}
                />
              ))}
            </div>
          </div>

          {/* Classifier detail table */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase text-gray-400">
              Classifier Detail
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-gray-400">
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4">Prior (a, b)</th>
                    <th className="py-2 pr-4">Confirmed</th>
                    <th className="py-2 pr-4">False Alarm</th>
                    <th className="py-2 pr-4">Posterior (a, b)</th>
                    <th className="py-2 pr-4">Mean</th>
                    <th className="py-2 pr-4">Sample Size</th>
                    <th className="py-2">Strength</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(classifier.categories).map(([cat, s]) => (
                    <tr key={cat} className="border-b border-gray-50">
                      <td className="py-2 pr-4 font-medium">
                        {categoryLabels[cat] ?? cat}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        ({s.prior.alpha}, {s.prior.beta})
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {s.local_verdicts.confirmed}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {s.local_verdicts.false_alarm}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        ({s.posterior.alpha}, {s.posterior.beta})
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {s.posterior.mean.toFixed(3)}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {s.effective_sample_size}
                      </td>
                      <td className="py-2 text-xs text-gray-500">
                        {classifier.interpretation[cat]?.data_strength ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Verdict summary */}
      {verdictSummary && (
        <div className="rounded border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase text-gray-400">
            Verdict History
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total Verdicts" value={String(verdictSummary.total)} />
            <Stat
              label="Confirmed Failures"
              value={String(verdictSummary.by_verdict.confirmed_failure ?? 0)}
            />
            <Stat
              label="False Alarms"
              value={String(verdictSummary.by_verdict.false_alarm ?? 0)}
            />
            <Stat
              label="Uncertain"
              value={String(verdictSummary.by_verdict.uncertain ?? 0)}
            />
          </div>
          {Object.keys(verdictSummary.by_category).length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase text-gray-400">
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4">Confirmed</th>
                    <th className="py-2 pr-4">False Alarm</th>
                    <th className="py-2">Uncertain</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(verdictSummary.by_category).map(
                    ([cat, counts]) => (
                      <tr key={cat} className="border-b border-gray-50">
                        <td className="py-2 pr-4 font-medium">
                          {categoryLabels[cat] ?? cat}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {counts.confirmed_failure ?? 0}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {counts.false_alarm ?? 0}
                        </td>
                        <td className="py-2 font-mono text-xs">
                          {counts.uncertain ?? 0}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
