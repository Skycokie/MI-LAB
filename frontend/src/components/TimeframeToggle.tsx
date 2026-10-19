"use client";

type Props = {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
  label?: string;
};

export default function TimeframeToggle({
  value,
  options,
  onChange,
  label = "TF",
}: Props) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
        {label}
      </span>
      <div
        className="inline-flex rounded border border-zinc-800 bg-black p-0.5"
        role="group"
        aria-label="Chart timeframe"
      >
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              aria-pressed={active}
              className={`rounded px-2.5 py-1 font-mono text-[11px] transition ${
                active
                  ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40"
                  : "text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
