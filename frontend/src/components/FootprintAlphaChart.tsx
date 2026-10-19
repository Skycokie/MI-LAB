"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchJson,
  withRefresh,
  type AbsorptionResponse,
  type AbsorptionSignal,
  type FootprintCandle,
  type FootprintResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";
import TimeframeToggle from "@/components/TimeframeToggle";

type Props = {
  symbol?: string;
  refreshKey?: number;
};

const FP_INTERVALS = ["1m", "5m", "15m"] as const;

const CANDLE_W = 118;
const CELL_H = 18;
const PAD_Y = 36;
const LABEL_W = 64;

function fmtVol(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

function fmtPrice(n: number, tick: number): string {
  const decimals = tick < 0.01 ? 4 : tick < 1 ? 3 : tick < 10 ? 2 : 1;
  return n.toFixed(decimals);
}

export default function FootprintAlphaChart({
  symbol,
  refreshKey,
}: Props) {
  const lab = useLab();
  const resolvedSymbol = (symbol ?? lab.activeSymbol).toUpperCase();
  const resolvedRefresh = refreshKey ?? lab.refreshKey;
  const [chartInterval, setChartInterval] = useState<string>("15m");

  const [data, setData] = useState<FootprintResponse | null>(null);
  const [absorptions, setAbsorptions] = useState<AbsorptionSignal[]>([]);
  const [absWarning, setAbsWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${resolvedSymbol}|${resolvedRefresh}|${chartInterval}`;

  useEffect(() => {
    let cancelled = false;
    const fpPath = withRefresh(
      `/api/footprint/${encodeURIComponent(resolvedSymbol)}?interval=${encodeURIComponent(chartInterval)}&candles=12&imbalance_ratio=3`,
      resolvedRefresh,
    );
    const absPath = withRefresh(
      `/api/absorption/${encodeURIComponent(resolvedSymbol)}?interval=${encodeURIComponent(chartInterval)}&limit=40`,
      resolvedRefresh,
    );

    Promise.all([
      fetchJson<FootprintResponse>(fpPath),
      fetchJson<AbsorptionResponse>(absPath).catch((err: Error) => {
        if (!cancelled) setAbsWarning(err.message);
        return null;
      }),
    ])
      .then(([fp, abs]) => {
        if (cancelled) return;
        setData(fp);
        setAbsorptions(abs?.signals ?? []);
        if (abs) setAbsWarning(null);
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
  }, [resolvedSymbol, resolvedRefresh, requestKey, chartInterval]);

  const loading = fetchedFor !== requestKey;

  const absByTime = useMemo(() => {
    const map = new Map<number, AbsorptionSignal>();
    for (const s of absorptions) {
      if (s.time != null) map.set(s.time, s);
    }
    return map;
  }, [absorptions]);

  const layout = useMemo(() => {
    if (!data || data.candles.length === 0) return null;
    const allPrices = new Set<number>();
    for (const c of data.candles) {
      for (const l of c.levels) allPrices.add(l.price);
      allPrices.add(c.high);
      allPrices.add(c.low);
    }
    const prices = [...allPrices].sort((a, b) => b - a);
    const priceIndex = new Map(prices.map((p, i) => [p, i]));
    const height = PAD_Y * 2 + prices.length * CELL_H;
    const width = LABEL_W + data.candles.length * CANDLE_W + 16;
    return { prices, priceIndex, height, width };
  }, [data]);

  const titleBlock = (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100">
        Footprint Alpha — {data?.symbol ?? resolvedSymbol}
      </h2>
      <p className="text-xs text-zinc-500">
        {data
          ? `${data.yahoo_symbol} · ${data.interval} · tick ${data.tick_size} · ratio ${data.imbalance_ratio}x · estimated order flow${data.proxy_note ? ` · ${data.proxy_note}` : ""}`
          : `${chartInterval} candles`}
      </p>
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {titleBlock}
          <TimeframeToggle
            value={chartInterval}
            options={FP_INTERVALS}
            onChange={setChartInterval}
          />
        </div>
        <div className="flex h-[480px] items-center justify-center text-sm text-zinc-500">
          Loading footprint for {resolvedSymbol} ({chartInterval})...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {titleBlock}
          <TimeframeToggle
            value={chartInterval}
            options={FP_INTERVALS}
            onChange={setChartInterval}
          />
        </div>
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!data || !layout) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {titleBlock}
        <div className="flex flex-wrap items-center gap-3">
          <TimeframeToggle
            value={chartInterval}
            options={FP_INTERVALS}
            onChange={setChartInterval}
          />
          <div className="flex flex-wrap gap-3 text-[11px] text-zinc-500">
            <LegendSwatch color="#ef4444" label="Bid (sell aggressor)" />
            <LegendSwatch color="#22c55e" label="Ask (buy aggressor)" />
            <LegendSwatch color="#f97316" label="Buying imbalance" bright />
            <LegendSwatch color="#e11d48" label="Selling imbalance" bright />
          </div>
        </div>
      </div>

      {absWarning && (
        <p className="text-[11px] text-amber-500/80">
          Absorption overlay unavailable: {absWarning}
        </p>
      )}

      <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950">
        <svg
          width={layout.width}
          height={layout.height}
          className="block min-w-full"
          role="img"
          aria-label={`Footprint chart for ${data.symbol}`}
        >
          {/* Price axis */}
          {layout.prices.map((price, i) => {
            const y = PAD_Y + i * CELL_H;
            return (
              <text
                key={`p-${price}`}
                x={LABEL_W - 6}
                y={y + CELL_H / 2 + 3}
                textAnchor="end"
                fill="#71717a"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                {fmtPrice(price, data.tick_size)}
              </text>
            );
          })}

          {data.candles.map((candle, ci) => (
            <FootprintCandleColumn
              key={candle.time}
              candle={candle}
              x={LABEL_W + ci * CANDLE_W}
              priceIndex={layout.priceIndex}
              tickSize={data.tick_size}
              absorption={absByTime.get(candle.time) ?? null}
              chartHeight={layout.height}
            />
          ))}
        </svg>
      </div>

      <p className="text-xs text-zinc-500">
        Diagonal imbalance: Ask at P vs Bid at P−1 tick. Bright cells mark
        institutional aggression (≥{data.imbalance_ratio}×). Green/red dots
        mark absorption (effort vs result) on the same {data.interval} candles.
        Delta and bid/ask are estimated from 1m OHLC — not live tick data.
      </p>
    </div>
  );
}

function FootprintCandleColumn({
  candle,
  x,
  priceIndex,
  tickSize,
  absorption,
  chartHeight,
}: {
  candle: FootprintCandle;
  x: number;
  priceIndex: Map<number, number>;
  tickSize: number;
  absorption: AbsorptionSignal | null;
  chartHeight: number;
}) {
  const bullish = candle.close >= candle.open;
  const stroke = bullish ? "#22c55e" : "#ef4444";
  const midX = x + CANDLE_W / 2;
  const half = (CANDLE_W - 12) / 2;

  const highIdx = nearestIndex(priceIndex, candle.high);
  const lowIdx = nearestIndex(priceIndex, candle.low);
  const openIdx = nearestIndex(priceIndex, candle.open);
  const closeIdx = nearestIndex(priceIndex, candle.close);

  const wickTop = PAD_Y + Math.min(highIdx, lowIdx) * CELL_H;
  const wickBot = PAD_Y + Math.max(highIdx, lowIdx) * CELL_H + CELL_H;
  const bodyTop = PAD_Y + Math.min(openIdx, closeIdx) * CELL_H;
  const bodyBot = PAD_Y + Math.max(openIdx, closeIdx) * CELL_H + CELL_H;

  return (
    <g>
      {/* Candle outline / body backdrop */}
      <rect
        x={x + 4}
        y={bodyTop}
        width={CANDLE_W - 8}
        height={Math.max(bodyBot - bodyTop, CELL_H)}
        fill={bullish ? "rgba(34,197,94,0.06)" : "rgba(239,68,68,0.06)"}
        stroke={stroke}
        strokeWidth={1}
        rx={2}
      />
      <line
        x1={midX}
        y1={wickTop}
        x2={midX}
        y2={wickBot}
        stroke={stroke}
        strokeWidth={1}
        opacity={0.5}
      />

      {/* Bid / Ask cells */}
      {candle.levels.map((lvl) => {
        const idx = priceIndex.get(lvl.price);
        if (idx == null) return null;
        const y = PAD_Y + idx * CELL_H;
        const isPoc = candle.poc != null && Math.abs(lvl.price - candle.poc) < tickSize * 0.01;
        const bidBg = lvl.selling_imbalance
          ? "#e11d48"
          : "rgba(239,68,68,0.18)";
        const askBg = lvl.buying_imbalance
          ? "#f97316"
          : "rgba(34,197,94,0.18)";
        const bidFg = lvl.selling_imbalance ? "#fff" : "#fca5a5";
        const askFg = lvl.buying_imbalance ? "#fff" : "#86efac";

        return (
          <g key={`${candle.time}-${lvl.price}`}>
            <rect
              x={midX - half}
              y={y + 1}
              width={half - 1}
              height={CELL_H - 2}
              fill={bidBg}
              stroke={isPoc ? "#f59e0b" : "transparent"}
              strokeWidth={isPoc ? 1.5 : 0}
            />
            <text
              x={midX - half / 2 - 0.5}
              y={y + CELL_H / 2 + 3}
              textAnchor="middle"
              fill={bidFg}
              fontSize={9}
              fontFamily="ui-monospace, monospace"
              fontWeight={lvl.selling_imbalance ? 700 : 400}
            >
              {fmtVol(lvl.bid)}
            </text>
            <rect
              x={midX + 1}
              y={y + 1}
              width={half - 1}
              height={CELL_H - 2}
              fill={askBg}
              stroke={isPoc ? "#f59e0b" : "transparent"}
              strokeWidth={isPoc ? 1.5 : 0}
            />
            <text
              x={midX + half / 2 + 0.5}
              y={y + CELL_H / 2 + 3}
              textAnchor="middle"
              fill={askFg}
              fontSize={9}
              fontFamily="ui-monospace, monospace"
              fontWeight={lvl.buying_imbalance ? 700 : 400}
            >
              {fmtVol(lvl.ask)}
            </text>
          </g>
        );
      })}

      {/* Delta label under candle */}
      <text
        x={midX}
        y={chartHeight - 10}
        textAnchor="middle"
        fill={candle.delta >= 0 ? "#86efac" : "#fca5a5"}
        fontSize={9}
        fontFamily="ui-monospace, monospace"
      >
        Δ {candle.delta >= 0 ? "+" : ""}
        {fmtVol(candle.delta)}
      </text>

      {/* Absorption marker */}
      {absorption && (
        <circle
          cx={midX}
          cy={
            absorption.absorption_type === "BULLISH_ABSORPTION"
              ? wickBot + 8
              : wickTop - 8
          }
          r={5}
          fill={
            absorption.absorption_type === "BULLISH_ABSORPTION"
              ? "#22c55e"
              : "#ef4444"
          }
          stroke="#09090b"
          strokeWidth={1.5}
        >
          <title>
            {absorption.absorption_type} · vol {fmtVol(absorption.volume)} · Δ{" "}
            {absorption.delta}
          </title>
        </circle>
      )}
    </g>
  );
}

function nearestIndex(priceIndex: Map<number, number>, price: number): number {
  let bestKey = 0;
  let bestDist = Infinity;
  for (const [p, idx] of priceIndex) {
    const d = Math.abs(p - price);
    if (d < bestDist) {
      bestDist = d;
      bestKey = idx;
    }
  }
  return bestKey;
}

function LegendSwatch({
  color,
  label,
  bright = false,
}: {
  color: string;
  label: string;
  bright?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{
          background: color,
          boxShadow: bright ? `0 0 6px ${color}` : undefined,
        }}
      />
      {label}
    </span>
  );
}
