interface Props {
  flag: string;
  confidence: string | null;
}

const confidenceColor: Record<string, string> = {
  high: "bg-red-100 text-red-800 border-red-200",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

export default function FlagBadge({ flag, confidence }: Props) {
  const color = confidenceColor[confidence ?? "low"] ?? confidenceColor.low;
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${color}`}>
      {flag}
      {confidence && (
        <span className="ml-1 opacity-70">({confidence})</span>
      )}
    </span>
  );
}
