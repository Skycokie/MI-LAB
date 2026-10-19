"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchJson,
  isGexUnavailable,
  withRefresh,
  type GexAvailable,
  type GexResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";

type Props = {
  ticker?: string;
  /** Increment to force a reload (bypasses the server cache). */
  refreshKey?: number;
};

function formatGex(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export default function GexChart({ ticker, refreshKey }: Props) {
  const lab = useLab();
  const resolvedTicker = (ticker ?? lab.activeSymbol).toUpperCase();
  const resolvedRefresh = refreshKey ?? lab.refreshKey;
  const { setTab } = lab;

  const [data, setData] = useState<GexResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${resolvedTicker}|${resolvedRefresh}`;

  useEffect(() => {
    let cancelled = false;
    fetchJson<GexResponse>(
      withRefresh(
        `/api/gex/${encodeURIComponent(resolvedTicker)}?expirations=4`,
        resolvedRefresh,
      ),
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
  }, [resolvedTicker, resolvedRefresh, requestKey]);

  const loading = fetchedFor !== requestKey;

  const chartData = useMemo(() => {
    if (!data || isGexUnavailable(data)) return [];
    // High strikes at top (price-chart convention for Recharts vertical layout).
    return [...data.levels]
      .filter((l) => Math.abs(l.total_gex) > 1e-6)
      .sort((a, b) => b.strike - a.strike)
      .map((l) => ({
        ...l,
        strikeLabel: l.strike.toFixed(0),
      }));
  }, [data]);

  const spotStrikeLabel = useMemo(() => {
    if (!data || isGexUnavailable(data) || chartData.length === 0) return null;
    let best = chartData[0];
    let bestDist = Math.abs(best.strike - data.spot_price);
    for (const row of chartData) {
      const d = Math.abs(row.strike - data.spot_price);
      if (d < bestDist) {
        best = row;
        bestDist = d;
      }
    }
    return best.strikeLabel;
  }, [data, chartData]);

  if (loading) {
    return (
      <div className="flex h-[420px] items-center justify-center text-sm text-zinc-400">
        Loading GEX for {resolvedTicker}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!data) return null;

  if (isGexUnavailable(data)) {
    return (
      <div className="flex min-h-[320px] flex-col justify-center gap-5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-6 py-10">
        <div className="space-y-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {data.reason === "EUROPEAN_NO_US_OPTIONS"
              ? "European market · no Eurex feed"
              : "No options chain"}
          </p>
          <h2 className="text-xl font-semibold text-zinc-100">
            GEX indisponibil — {data.ticker}
          </h2>
          <p className="max-w-xl text-sm leading-relaxed text-zinc-400">
            {data.message}
          </p>
          {data.yahoo_symbol && data.yahoo_symbol !== data.ticker && (
            <p className="font-mono text-xs text-zinc-600">
              Yahoo: {data.yahoo_symbol}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => setTab("vp")}
            className="rounded border border-zinc-600 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-amber-500 hover:text-amber-400"
          >
            Deschide Volume Profile
          </button>
          <button
            type="button"
            onClick={() => setTab("fp")}
            className="rounded border border-zinc-600 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-200 transition hover:border-amber-500 hover:text-amber-400"
          >
            Deschide Footprint
          </button>
        </div>
      </div>
    );
  }

  const available = data as GexAvailable;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            Gamma Exposure — {available.ticker}
          </h2>
          <p className="text-xs text-zinc-500">
            Exp {available.expiration}
            {available.expirations.length > 1
              ? ` (+${available.expirations.length - 1} more)`
              : ""}{" "}
            · Spot {available.spot_price}
            {available.interest_source === "volume_fallback"
              ? " · interest via volume (OI empty)"
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <MetaChip
            label="Spot"
            value={String(available.spot_price)}
            tone="amber"
          />
          <MetaChip label="Net GEX" value={formatGex(available.net_gex)} />
          {available.gamma_flip != null && (
            <MetaChip
              label="Gamma Flip"
              value={String(available.gamma_flip)}
            />
          )}
          {available.call_wall != null && (
            <MetaChip
              label="Call Wall"
              value={String(available.call_wall)}
              tone="green"
            />
          )}
          {available.put_wall != null && (
            <MetaChip
              label="Put Wall"
              value={String(available.put_wall)}
              tone="red"
            />
          )}
        </div>
      </div>

      <div className="h-[420px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#27272a"
              horizontal={false}
            />
            <XAxis
              type="number"
              stroke="#71717a"
              tick={{ fill: "#a1a1aa", fontSize: 11 }}
              tickFormatter={formatGex}
            />
            <YAxis
              type="category"
              dataKey="strikeLabel"
              width={52}
              stroke="#71717a"
              tick={{ fill: "#a1a1aa", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #3f3f46",
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: "#e4e4e7" }}
              formatter={(value) => [
                formatGex(Number(value ?? 0)),
                "Total GEX",
              ]}
              labelFormatter={(label) => `Strike ${label}`}
            />
            {spotStrikeLabel && (
              <ReferenceLine
                y={spotStrikeLabel}
                stroke="#fbbf24"
                strokeDasharray="4 4"
                strokeWidth={2}
                label={{
                  value: `Spot ${available.spot_price}`,
                  fill: "#fbbf24",
                  fontSize: 11,
                  position: "insideTopRight",
                }}
              />
            )}
            <Bar dataKey="total_gex" radius={[0, 3, 3, 0]}>
              {chartData.map((entry) => (
                <Cell
                  key={entry.strike}
                  fill={entry.total_gex >= 0 ? "#22c55e" : "#ef4444"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-zinc-500">
        Green = Call Gamma (dealers long gamma) · Red = Put Gamma · Yellow =
        spot
      </p>
    </div>
  );
}

function MetaChip({
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
          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
          : "border-zinc-700 bg-zinc-800/80 text-zinc-300";
  return (
    <span className={`rounded-md border px-2 py-1 ${colors}`}>
      <span className="text-zinc-500">{label}: </span>
      {value}
    </span>
  );
}
