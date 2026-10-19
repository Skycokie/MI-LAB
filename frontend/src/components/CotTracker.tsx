"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchJson, withRefresh, type CotResponse } from "@/lib/api";
import CotForexCard, { fmtNet } from "@/components/CotForexCard";

export const COT_CURRENCIES = ["EUR", "GBP", "JPY", "CAD", "AUD"] as const;

type Props = {
  currency: string;
  onCurrencyChange: (currency: string) => void;
  refreshKey?: number;
};

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export default function CotTracker({
  currency,
  onCurrencyChange,
  refreshKey = 0,
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

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
        {loading ? (
          <div className="flex h-[360px] items-center justify-center text-sm text-zinc-500">
            Loading CFTC COT for {currency}...
          </div>
        ) : error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
            {error}
          </div>
        ) : data ? (
          <>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">
                  {data.currency} - Smart Money vs Retail
                </h2>
                <p className="text-xs text-zinc-500">
                  {data.market_name} - last {data.weeks} weekly reports - latest{" "}
                  {data.report_date}
                </p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <Chip
                  label="Smart Money"
                  value={fmtNet(data.non_commercials_net)}
                  tone={data.non_commercials_net >= 0 ? "green" : "red"}
                />
                <Chip label="Retail" value={fmtNet(data.retail_net)} tone="amber" />
                <Chip label="Commercials" value={fmtNet(data.commercials_net)} />
              </div>
            </div>

            <div className="h-[320px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data.history}
                  margin={{ top: 8, right: 16, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="report_date"
                    tickFormatter={(d: string) => d.slice(5)}
                    stroke="#71717a"
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                  />
                  <YAxis
                    stroke="#71717a"
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    tickFormatter={compact}
                    width={52}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#18181b",
                      border: "1px solid #3f3f46",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(value, name) => [fmtNet(Number(value ?? 0)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: "#a1a1aa" }} />
                  <ReferenceLine y={0} stroke="#52525b" />
                  <Bar
                    dataKey="non_commercials_net"
                    name="Smart Money (Non-Comm)"
                    fill="#22c55e"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="retail_net"
                    name="Retail (Non-Rept)"
                    fill="#f59e0b"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    dataKey="commercials_net"
                    name="Commercials"
                    fill="#38bdf8"
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-[11px] text-zinc-600">
              Net positions = long - short. Source: {data.source}.
            </p>
          </>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {COT_CURRENCIES.map((c) => (
          <CotForexCard
            key={c}
            currency={c}
            refreshKey={refreshKey}
            active={c === currency}
            onSelect={onCurrencyChange}
          />
        ))}
      </div>
    </div>
  );
}

function Chip({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "green" | "red" | "amber";
}) {
  const colors =
    tone === "green"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : tone === "amber"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : "border-zinc-700 bg-zinc-800/80 text-zinc-300";
  return (
    <span className={`rounded border px-2 py-1 font-mono ${colors}`}>
      <span className="font-sans text-zinc-500">{label}: </span>
      {value}
    </span>
  );
}
