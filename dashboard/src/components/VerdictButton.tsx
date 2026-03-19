interface Props {
  verdict: "confirmed_failure" | "false_alarm" | "uncertain";
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}

const styles: Record<string, { base: string; active: string }> = {
  confirmed_failure: {
    base: "border-red-200 text-red-700 hover:bg-red-50",
    active: "bg-red-600 text-white border-red-600",
  },
  false_alarm: {
    base: "border-green-200 text-green-700 hover:bg-green-50",
    active: "bg-green-600 text-white border-green-600",
  },
  uncertain: {
    base: "border-gray-200 text-gray-600 hover:bg-gray-50",
    active: "bg-gray-600 text-white border-gray-600",
  },
};

const labels: Record<string, string> = {
  confirmed_failure: "Confirmed Failure",
  false_alarm: "False Alarm",
  uncertain: "Uncertain",
};

export default function VerdictButton({ verdict, onClick, disabled, active }: Props) {
  const s = styles[verdict];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
        active ? s.active : s.base
      }`}
    >
      {labels[verdict]}
    </button>
  );
}
