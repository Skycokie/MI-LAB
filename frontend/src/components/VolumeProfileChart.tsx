"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchJson,
  withRefresh,
  type AbsorptionResponse,
  type AbsorptionSignal,
  type VolumeProfileResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";
import TimeframeToggle from "@/components/TimeframeToggle";

type Props = {
  symbol?: string;
  refreshKey?: number;
};

const VP_INTERVALS = ["1m", "2m", "5m", "15m"] as const;

export default function VolumeProfileChart({
  symbol,
  refreshKey,
}: Props) {
  const lab = useLab();
  const resolvedSymbol = (symbol ?? lab.activeSymbol).toUpperCase();
  const resolvedRefresh = refreshKey ?? lab.refreshKey;
  const [chartInterval, setChartInterval] = useState<string>("5m");
  const [data, setData] = useState<VolumeProfileResponse | null>(null);
  const [absorptions, setAbsorptions] = useState<AbsorptionSignal[]>([]);
  const [absWarning, setAbsWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${resolvedSymbol}|${resolvedRefresh}|${chartInterval}`;

  useEffect(() => {
    let cancelled = false;
    // Absorption API supports 1m/5m/15m only — map VP 2m bars to 5m overlay.
    const absInterval = chartInterval === "2m" ? "5m" : chartInterval;
    const vpPath = withRefresh(
      `/api/volume-profile/${encodeURIComponent(resolvedSymbol)}?bins=40&interval=${encodeURIComponent(chartInterval)}`,
      resolvedRefresh,
    );
    const absPath = withRefresh(
      `/api/absorption/${encodeURIComponent(resolvedSymbol)}?interval=${encodeURIComponent(absInterval)}&limit=40`,
      resolvedRefresh,
    );

    Promise.all([
      fetchJson<VolumeProfileResponse>(vpPath),
      fetchJson<AbsorptionResponse>(absPath).catch((err: Error) => {
        if (!cancelled) setAbsWarning(err.message);
        return null;
      }),
    ])
      .then(([vp, abs]) => {
        if (cancelled) return;
        setData(vp);
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

  const titleBlock = (
    <div>
      <h2 className="text-lg font-semibold text-zinc-100">
        Volume Profile
        {data ? ` - ${data.symbol}` : ` - ${resolvedSymbol}`}
      </h2>
      <p className="text-xs text-zinc-500">
        {data
          ? `Profile of session ${data.session_date} - ${data.yahoo_symbol} - ${data.interval} bars${data.proxy_note ? ` - ${data.proxy_note}` : ""}`
          : `${chartInterval} bars`}
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
            options={VP_INTERVALS}
            onChange={setChartInterval}
          />
        </div>
        <div className="flex h-[440px] items-center justify-center text-sm text-zinc-500">
          Loading volume profile for {resolvedSymbol} ({chartInterval})...
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
            options={VP_INTERVALS}
            onChange={setChartInterval}
          />
        </div>
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const bullishCount = absorptions.filter(
    (s) => s.absorption_type === "BULLISH_ABSORPTION",
  ).length;
  const bearishCount = absorptions.filter(
    (s) => s.absorption_type === "BEARISH_ABSORPTION",
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {titleBlock}
        <div className="flex flex-wrap items-center gap-3">
          <TimeframeToggle
            value={chartInterval}
            options={VP_INTERVALS}
            onChange={setChartInterval}
          />
          <div className="flex flex-wrap gap-2 text-xs">
            <Chip label="POC" value={data.poc.toFixed(4)} tone="amber" />
            <Chip label="VAH" value={data.vah.toFixed(4)} tone="sky" />
            <Chip label="VAL" value={data.val.toFixed(4)} tone="sky" />
            <Chip
              label="Last"
              value={data.current_price.toFixed(4)}
              tone={data.inside_value_area ? "green" : "red"}
            />
            {data.retest_poc_signal && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-300">
                Re-test POC
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-violet-400" />
          VWAP
          {data.vwap != null ? ` ${data.vwap}` : ""}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rotate-45 bg-emerald-500" />
          Breakout ({(data.vwap_signals ?? []).filter((s) => s.type.includes("BREAKOUT")).length})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" />
          Pullback ({(data.vwap_signals ?? []).filter((s) => s.type.includes("PULLBACK")).length})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
          Bullish absorption ({bullishCount})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
          Bearish absorption ({bearishCount})
        </span>
        <span className="text-zinc-600">estimated delta from 1m OHLC</span>
      </div>

      {absWarning && (
        <p className="text-[11px] text-amber-500/80">
          Absorption markers unavailable: {absWarning}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <PriceLevelsChart data={data} absorptions={absorptions} />
        <Histogram data={data} />
      </div>

      <p className="text-xs text-zinc-500">
        POC = most traded price · VAH/VAL = 70% volume area · violet line =
        session VWAP. Diamonds = VWAP breakout (vol ≥ 1.5× SMA20) · squares =
        VWAP pullback retest. Circles = absorption (effort vs result).
      </p>
    </div>
  );
}

/** Candlestick chart with POC / VAH / VAL lines and absorption markers. */
function PriceLevelsChart({
  data,
  absorptions,
}: {
  data: VolumeProfileResponse;
  absorptions: AbsorptionSignal[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#18181b" },
        horzLines: { color: "#18181b" },
      },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    });

    const priceFmt = {
      type: "price" as const,
      precision: data.current_price < 20 ? 4 : 2,
      minMove: data.current_price < 20 ? 0.0001 : 0.01,
    };

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceFormat: priceFmt,
    });

    const candleTimes = new Set(data.candles.map((c) => c.time));

    series.setData(
      data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const vwapSeries = chart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      title: "VWAP",
      priceFormat: priceFmt,
    });
    const vwapPoints = (data.vwap_series ?? []).map((p) => ({
      time: p.time as UTCTimestamp,
      value: p.vwap,
    }));
    if (vwapPoints.length > 0) {
      vwapSeries.setData(vwapPoints);
    }

    const line = (
      price: number,
      title: string,
      color: string,
      lineStyle: LineStyle,
      lineWidth: 1 | 2,
    ) =>
      series.createPriceLine({
        price,
        title,
        color,
        lineStyle,
        lineWidth,
        axisLabelVisible: true,
      });

    line(data.poc, "POC", "#f59e0b", LineStyle.Solid, 2);
    line(data.vah, "VAH", "#38bdf8", LineStyle.Dashed, 1);
    line(data.val, "VAL", "#38bdf8", LineStyle.Dashed, 1);
    if (data.vwap != null) {
      line(data.vwap, "VWAP", "#a78bfa", LineStyle.Dotted, 1);
    }

    const absMarkers = absorptions
      .filter((s) => s.time != null && candleTimes.has(s.time))
      .map((s) => {
        const bullish = s.absorption_type === "BULLISH_ABSORPTION";
        return {
          time: s.time as UTCTimestamp,
          position: bullish ? ("belowBar" as const) : ("aboveBar" as const),
          color: bullish ? "#22c55e" : "#ef4444",
          shape: "circle" as const,
          text: bullish ? "ABS+" : "ABS-",
        };
      });

    const vwapMarkers = (data.vwap_signals ?? []).map((s) => {
      const isBreakout = s.type.includes("BREAKOUT");
      const up =
        s.type === "VWAP_BREAKOUT_UP" || s.type === "VWAP_PULLBACK_LONG";
      if (isBreakout) {
        return {
          time: s.time as UTCTimestamp,
          position: up ? ("belowBar" as const) : ("aboveBar" as const),
          color: up ? "#22c55e" : "#ef4444",
          shape: up ? ("arrowUp" as const) : ("arrowDown" as const),
          text: up ? "BO↑" : "BO↓",
        };
      }
      return {
        time: s.time as UTCTimestamp,
        position: up ? ("belowBar" as const) : ("aboveBar" as const),
        color: "#fbbf24",
        shape: "square" as const,
        text: up ? "PB+" : "PB-",
      };
    });

    const markers = [...absMarkers, ...vwapMarkers].sort(
      (a, b) => Number(a.time) - Number(b.time),
    );

    if (markers.length > 0) {
      createSeriesMarkers(series, markers);
    }

    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [data, absorptions]);

  return (
    <div
      ref={containerRef}
      className="h-[440px] w-full overflow-hidden rounded border border-zinc-800"
    />
  );
}

/** Horizontal volume-by-price histogram of the profiled session. */
function Histogram({ data }: { data: VolumeProfileResponse }) {
  const rows = useMemo(
    () =>
      [...data.levels]
        .sort((a, b) => b.price - a.price)
        .map((l) => ({ ...l, priceLabel: l.price.toFixed(4) })),
    [data],
  );

  const nearest = (target: number) =>
    rows.reduce(
      (best, r) =>
        Math.abs(r.price - target) < Math.abs(best.price - target) ? r : best,
      rows[0],
    )?.priceLabel;

  return (
    <div className="h-[440px] rounded border border-zinc-800 bg-zinc-950 p-2">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
          barCategoryGap={1}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="priceLabel"
            width={58}
            tick={{ fill: "#71717a", fontSize: 9 }}
            interval="preserveStartEnd"
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
            formatter={(value) => [Number(value ?? 0).toLocaleString(), "Volume"]}
            labelFormatter={(label) => `Price ${label}`}
          />
          <ReferenceLine y={nearest(data.vah)} stroke="#38bdf8" strokeDasharray="3 3" />
          <ReferenceLine y={nearest(data.val)} stroke="#38bdf8" strokeDasharray="3 3" />
          <Bar dataKey="volume">
            {rows.map((r) => (
              <Cell
                key={r.price}
                fill={r.is_poc ? "#f59e0b" : r.in_value_area ? "#3b82f6" : "#52525b"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
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
  tone?: "neutral" | "green" | "red" | "amber" | "sky";
}) {
  const colors =
    tone === "green"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : tone === "amber"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
          : tone === "sky"
            ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
            : "border-zinc-700 bg-zinc-800/80 text-zinc-300";
  return (
    <span className={`rounded border px-2 py-1 font-mono ${colors}`}>
      <span className="font-sans text-zinc-500">{label}: </span>
      {value}
    </span>
  );
}
