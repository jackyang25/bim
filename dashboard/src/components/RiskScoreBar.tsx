interface Props {
  label: string;
  score: number;
  thresholds: {
    escalate_now_safety: number;
    escalate_now: number;
    human_review: number;
    log_only: number;
  };
  isSafety?: boolean;
}

function routingLabel(score: number, isSafety: boolean, thresholds: Props["thresholds"]): string {
  const escalateThreshold = isSafety ? thresholds.escalate_now_safety : thresholds.escalate_now;
  if (score >= escalateThreshold) return "escalate_now";
  if (score >= thresholds.human_review) return "human_review";
  if (score >= thresholds.log_only) return "log_only";
  return "pass";
}

const routingColor: Record<string, string> = {
  escalate_now: "bg-red-500",
  human_review: "bg-yellow-500",
  log_only: "bg-blue-400",
  pass: "bg-green-500",
};

export default function RiskScoreBar({ label, score, thresholds, isSafety }: Props) {
  const routing = routingLabel(score, !!isSafety, thresholds);
  const pct = Math.round(score * 100);
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-44 shrink-0 font-medium text-gray-700">{label}</span>
      <div className="relative h-4 flex-1 overflow-hidden rounded bg-gray-200">
        <div
          className={`absolute inset-y-0 left-0 rounded ${routingColor[routing]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-12 text-right tabular-nums text-gray-500">{pct}%</span>
      <span className="w-24 text-xs text-gray-400">{routing}</span>
    </div>
  );
}
