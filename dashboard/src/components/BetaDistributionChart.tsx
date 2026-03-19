import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

interface Props {
  alpha: number;
  beta: number;
  label: string;
  thresholds: {
    escalate_now_safety: number;
    escalate_now: number;
    human_review: number;
    log_only: number;
  };
  isSafety?: boolean;
}

// Log Beta function using Stirling's approximation for large values,
// direct computation for small values.
function logGamma(z: number): number {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaPdf(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  const logB = logGamma(a) + logGamma(b) - logGamma(a + b);
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - logB);
}

export default function BetaDistributionChart({
  alpha,
  beta: betaParam,
  label,
  thresholds,
  isSafety,
}: Props) {
  const points = [];
  const steps = 200;
  for (let i = 1; i < steps; i++) {
    const x = i / steps;
    points.push({ x: Math.round(x * 100) / 100, density: betaPdf(x, alpha, betaParam) });
  }

  const escalateThreshold = isSafety
    ? thresholds.escalate_now_safety
    : thresholds.escalate_now;

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-gray-700">{label}</h4>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={points} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, 1]}
            ticks={[0, 0.25, 0.5, 0.75, 1]}
            tick={{ fontSize: 11 }}
          />
          <YAxis hide />
          <Tooltip
            formatter={(value: number) => value.toFixed(2)}
            labelFormatter={(l: number) => `p = ${l}`}
          />
          <Line
            type="monotone"
            dataKey="density"
            stroke="#1e40af"
            strokeWidth={2}
            dot={false}
          />
          <ReferenceLine
            x={thresholds.human_review}
            stroke="#eab308"
            strokeDasharray="4 4"
            label={{ value: "review", position: "top", fontSize: 10 }}
          />
          <ReferenceLine
            x={escalateThreshold}
            stroke="#dc2626"
            strokeDasharray="4 4"
            label={{ value: "escalate", position: "top", fontSize: 10 }}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 text-center text-xs text-gray-400">
        Beta({alpha}, {betaParam}) — mean{" "}
        {(alpha / (alpha + betaParam)).toFixed(3)}
      </p>
    </div>
  );
}
