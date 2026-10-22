"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";
import { Sparkles } from "lucide-react";
import {
  fetchJson,
  isForecastUnavailable,
  withRefresh,
  type ForecastResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";
import TimeframeToggle from "@/components/TimeframeToggle";

const INTERVALS = ["5m", "15m"] as const;
const PRED_LENS = ["12", "24", "48"] as const;

export default function ForecastBoard() {
  const lab = useLab();
  const symbol = lab.activeSymbol.toUpperCase();
  const refreshKey = lab.refreshKey;

  const [interval, setIntervalTf] = useState("5m");
  const [predLen, setPredLen] = useState("24");
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  const requestKey = `${symbol}|${interval}|${predLen}|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const qs = new URLSearchParams({
      interval,
      // Cap at Railway-safe lookback (backend also clamps via KRONOS_MAX_LOOKBACK).
      lookback: "256",
      pred_len: predLen,
    });
    const path = withRefresh(
      `/api/forecast/${encodeURIComponent(symbol)}?${qs}`,
      refreshKey,
    );

    const load = (attempt: number) => {
      fetchJson<ForecastResponse>(path)
        .then((json) => {
          if (cancelled) return;
          if (
            isForecastUnavailable(json) &&
            (json.reason === "MODEL_LOADING" || json.reason === "MODEL_BUSY") &&
            attempt < 6
          ) {
            setData(json);
            setError(null);
            retryTimer = setTimeout(() => load(attempt + 1), 5000);
            return;
          }
          setData(json);
          setError(null);
          setFetchedFor(requestKey);
        })
        .catch((err: Error) => {
          if (cancelled) return;
          const msg = err.message || "";
          const retryable =
            /internal server error|failed to fetch|timeout|gateway/i.test(msg);
          // At most 2 soft retries — hammering a stuck worker makes it worse.
          if (retryable && attempt < 2) {
            retryTimer = setTimeout(() => load(attempt + 1), 5000 * (attempt + 1));
            return;
          }
          setError(msg);
          setData(null);
          setFetchedFor(requestKey);
        });
    };

    load(0);

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [symbol, interval, predLen, refreshKey, requestKey]);

  const loading = fetchedFor !== requestKey;

  const sourceCaption = (() => {
    if (!data || isForecastUnavailable(data)) {
      return "Kronos-mini · experimental · Yahoo delayed ~15m · not trading advice";
    }
    if (data.delayed || data.source.startsWith("yahoo")) {
      return "Kronos-mini · experimental · Yahoo delayed ~15m · not trading advice";
    }
    if (data.source.startsWith("alpaca")) {
      return "Kronos-mini · experimental · Alpaca live · not trading advice";
    }
    if (data.source.startsWith("htx")) {
      return "Kronos-mini · experimental · HTX live · not trading advice";
    }
    return `Kronos-mini · experimental · ${data.source} · not trading advice`;
  })();

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold text-zinc-100">
          <Sparkles className="h-5 w-5 text-amber-400" />
          Kronos Forecast — {symbol}
        </h2>
        <p className="text-xs text-zinc-500">{sourceCaption}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <TimeframeToggle
          value={interval}
          options={INTERVALS}
          onChange={setIntervalTf}
          label="TF"
        />
        <TimeframeToggle
          value={predLen}
          options={PRED_LENS}
          onChange={setPredLen}
          label="Bars"
        />
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {header}
        <div className="flex h-[440px] items-center justify-center text-sm text-zinc-500">
          Loading forecast for {symbol}… (first run may download the model)
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  if (isForecastUnavailable(data)) {
    return (
      <div className="space-y-3">
        {header}
        <div className="flex min-h-[320px] flex-col justify-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/60 px-6 py-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {data.reason || "Kronos unavailable"}
          </p>
          <h3 className="text-xl font-semibold text-zinc-100">
            Forecast indisponibil
          </h3>
          <p className="max-w-xl text-sm leading-relaxed text-zinc-400">
            {data.message}
          </p>
          {data.install_hint && (
            <code className="w-fit rounded border border-zinc-700 bg-black px-3 py-2 font-mono text-xs text-amber-400">
              {data.install_hint}
            </code>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      <p className="text-[11px] text-zinc-600">{data.disclaimer}</p>
      <ForecastChart
        history={data.history}
        forecast={data.forecast}
        symbol={data.ticker}
      />
      <p className="text-xs text-zinc-500">
        Solid = history · dashed-style forecast candles = next {data.pred_len}{" "}
        × {data.interval} · model {data.model}
      </p>
    </div>
  );
}

function ForecastChart({
  history,
  forecast,
  symbol,
}: {
  history: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  forecast: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
  }>;
  symbol: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || history.length === 0) return;

    const last = history[history.length - 1]?.close ?? 1;
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
    });

    const histSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      priceFormat: {
        type: "price",
        precision: last < 20 ? 4 : 2,
        minMove: last < 20 ? 0.0001 : 0.01,
      },
    });

    histSeries.setData(
      history.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const fcSeries = chart.addSeries(CandlestickSeries, {
      upColor: "rgba(251, 191, 36, 0.55)",
      downColor: "rgba(251, 146, 60, 0.55)",
      borderUpColor: "#fbbf24",
      borderDownColor: "#f97316",
      wickUpColor: "#fbbf24",
      wickDownColor: "#f97316",
      priceFormat: {
        type: "price",
        precision: last < 20 ? 4 : 2,
        minMove: last < 20 ? 0.0001 : 0.01,
      },
    });

    // Bridge: last history close → first forecast open for visual continuity.
    const fcData = forecast.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    if (fcData.length > 0) {
      fcSeries.setData(fcData);
    }

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [history, forecast, symbol]);

  return (
    <div
      ref={containerRef}
      className="h-[440px] w-full overflow-hidden rounded border border-zinc-800"
      role="img"
      aria-label={`Kronos forecast chart for ${symbol}`}
    />
  );
}
