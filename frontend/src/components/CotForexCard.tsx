"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingDown, TrendingUp } from "lucide-react";
import { fetchJson, withRefresh, type CotResponse } from "@/lib/api";

type Props = {
  currency: string;
  refreshKey?: number;
  /** Highlights the card (used as selector in the COT tab). */
  active?: boolean;
  onSelect?: (currency: string) => void;
};

export function fmtNet(n: number): string {
  return new Intl.NumberFormat("en-US", {
    signDisplay: "exceptZero",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function CotForexCard({
  currency,
  refreshKey = 0,
  active = false,
  onSelect,
}: Props) {
  const [data, setData] = useState<CotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${currency}|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    fetchJson<CotResponse>(
      withRefresh(`/api/cot/${encodeURIComponent(currency)}?weeks=10`, refreshKey),
    )
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setError(null);
        setFetchedFor(requestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setData(null);
        setFetchedFor(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [currency, refreshKey, requestKey]);

  const loading = fetchedFor !== requestKey;
  const frame = `flex flex-col gap-3 rounded-lg border p-4 text-left transition ${
    active
      ? "border-amber-500/60 bg-zinc-900 ring-1 ring-amber-500/30"
      : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"
  } ${onSelect ? "cursor-pointer" : ""}`;

  if (loading) {
    return (
      <div className={frame}>
        <div className="h-32 animate-pulse rounded bg-zinc-800/80" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        {currency}: {error}
      </div>
    );
  }

  if (!data) return null;

  const smartLong = data.non_commercials_net > 0;
  const bars = [
    { name: "Smart Money", value: data.non_commercials_net },
    { name: "Retail", value: data.retail_net },
    { name: "Commercial", value: data.commercials_net },
  ];

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-mono text-base font-semibold text-amber-400">
            {data.currency}
          </h3>
          <p className="text-[11px] text-zinc-500">
            Report {data.report_date || "-"}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${
            smartLong
              ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
              : "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
          }`}
        >
          {smartLong ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <TrendingDown className="h-3 w-3" />
          )}
          {smartLong ? "Smart Money Long" : "Smart Money Short"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Non-Commercials" value={fmtNet(data.non_commercials_net)} />
        <Stat label="Retail" value={fmtNet(data.retail_net)} />
      </div>

      <div className="h-24 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} layout="vertical" margin={{ left: 4, right: 8 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={84}
              tick={{ fill: "#a1a1aa", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: 6,
                fontSize: 11,
              }}
              formatter={(value) => [fmtNet(Number(value ?? 0)), "Net"]}
            />
            <Bar dataKey="value" radius={[0, 3, 3, 0]}>
              {bars.map((b) => (
                <Cell key={b.name} fill={b.value >= 0 ? "#22c55e" : "#ef4444"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-zinc-600">
        Wk chg (Non-Comm) {fmtNet(data.weekly_change.non_commercials_net)} -{" "}
        {data.sentiment.replace(/_/g, " ")}
      </p>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={frame}
        onClick={() => onSelect(data.currency)}
        aria-pressed={active}
      >
        {body}
      </button>
    );
  }
  return <div className={frame}>{body}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-black/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="font-mono text-sm text-zinc-200">{value}</div>
    </div>
  );
}
