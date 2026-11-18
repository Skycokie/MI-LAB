"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import {
  fetchJson,
  withRefresh,
  type SmcFvg,
  type SmcLiquidityLevel,
  type SmcOrderBlock,
  type SmcResponse,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";
import TimeframeToggle from "@/components/TimeframeToggle";
import { fmtPriceFor, isFxSymbol, priceDecimals, priceMinMove } from "@/lib/format";

const SMC_INTERVALS = ["1m", "5m", "15m", "1h"] as const;

const ATR_FILTERS = [
  { label: "Toate (0.05×)", value: "0.05" },
  { label: "Standard (0.15×)", value: "0.15" },
  { label: "Displacement (0.35×)", value: "0.35" },
] as const;

type ZoneBox = {
  id: string;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
  extendRight: boolean;
  top: number;
  bottom: number;
  ce?: number;
  fillColor: string;
  borderColor: string;
  ceColor?: string;
  label?: string;
};

class SmcZonesRenderer implements IPrimitivePaneRenderer {
  private readonly _boxes: ZoneBox[];
  private readonly _param: SeriesAttachedParameter<Time> | null;

  constructor(boxes: ZoneBox[], param: SeriesAttachedParameter<Time> | null) {
    this._boxes = boxes;
    this._param = param;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const param = this._param;
    if (!param || this._boxes.length === 0) return;
    const { chart, series } = param;
    const timeScale = chart.timeScale();

    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const width = mediaSize.width;
      const height = mediaSize.height;

      for (const box of this._boxes) {
        const yTopRaw = series.priceToCoordinate(box.top);
        const yBotRaw = series.priceToCoordinate(box.bottom);
        if (yTopRaw == null || yBotRaw == null) continue;

        const y1 = Math.min(yTopRaw, yBotRaw);
        const y2 = Math.max(yTopRaw, yBotRaw);
        if (y2 < 0 || y1 > height) continue;

        const xStartRaw = timeScale.timeToCoordinate(box.startTime);
        const xEndRaw = timeScale.timeToCoordinate(box.endTime);

        const rawLeft = xStartRaw != null ? Number(xStartRaw) : 0;
        let rawRight = xEndRaw != null ? Number(xEndRaw) : width;
        if (box.extendRight) {
          rawRight = Math.max(rawRight, width);
        }

        const x1 = Math.max(0, Math.min(rawLeft, rawRight));
        const x2 = Math.min(width, Math.max(rawLeft, rawRight));
        if (x2 - x1 < 2) continue;

        const boxH = Math.max(1.5, y2 - y1);

        context.save();
        context.fillStyle = box.fillColor;
        context.fillRect(x1, y1, x2 - x1, boxH);

        context.strokeStyle = box.borderColor;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y1);
        context.moveTo(x1, y2);
        context.lineTo(x2, y2);
        context.stroke();

        if (box.ce != null && box.ceColor && boxH >= 6) {
          const yCe = series.priceToCoordinate(box.ce);
          if (yCe != null && yCe >= y1 && yCe <= y2) {
            context.strokeStyle = box.ceColor;
            context.lineWidth = 1;
            context.setLineDash([4, 4]);
            context.beginPath();
            context.moveTo(x1, yCe);
            context.lineTo(x2, yCe);
            context.stroke();
            context.setLineDash([]);
          }
        }

        if (box.label && x2 - x1 >= 38 && boxH >= 10) {
          context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
          context.fillStyle = box.borderColor;
          context.textBaseline = "top";
          const textX = Math.min(x2 - 4, Math.max(x1 + 4, width - 88));
          context.fillText(box.label, textX, y1 + 2);
        }

        context.restore();
      }
    });
  }
}

class SmcZonesPaneView implements IPrimitivePaneView {
  private readonly _source: SmcZonesPrimitive;

  constructor(source: SmcZonesPrimitive) {
    this._source = source;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SmcZonesRenderer(this._source.boxes, this._source.attachedParam);
  }
}

class SmcZonesPrimitive implements ISeriesPrimitive<Time> {
  boxes: ZoneBox[];
  attachedParam: SeriesAttachedParameter<Time> | null = null;
  private readonly _paneViews: readonly IPrimitivePaneView[];

  constructor(boxes: ZoneBox[]) {
    this.boxes = boxes;
    this._paneViews = [new SmcZonesPaneView(this)];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedParam = param;
  }

  detached(): void {
    this.attachedParam = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }
}

function fmt(n: number | null | undefined, symbol: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return isFxSymbol(symbol) ? fmtPriceFor(n, symbol) : n.toFixed(priceDecimals(n, symbol));
}

export default function SmcBoard({
  symbol,
  refreshKey,
}: {
  symbol?: string;
  refreshKey?: number;
}) {
  const lab = useLab();
  const resolvedSymbol = (symbol ?? lab.activeSymbol).toUpperCase();
  const resolvedRefresh = refreshKey ?? lab.refreshKey;

  const [interval, setIntervalState] = useState<string>("5m");
  const [atrMult, setAtrMult] = useState<string>("0.15");
  const [showOpenFvg, setShowOpenFvg] = useState(true);
  const [showMitigatedFvg, setShowMitigatedFvg] = useState(false);
  const [showOb, setShowOb] = useState(true);
  const [showStructure, setShowStructure] = useState(true);
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showOte, setShowOte] = useState(true);

  const [data, setData] = useState<SmcResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  // Auto-refresh la 30s ca ultima bară să rămână live (Alpaca WebSocket),
  // fără să depindă de butonul global Refresh.
  const [autoKey, setAutoKey] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAutoKey((k) => k + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const requestKey = `${resolvedSymbol}|${resolvedRefresh}|${interval}|${atrMult}|${autoKey}`;

  useEffect(() => {
    let cancelled = false;
    const path = withRefresh(
      `/api/smc/${encodeURIComponent(resolvedSymbol)}?interval=${encodeURIComponent(interval)}&bars=240&min_atr_mult=${encodeURIComponent(atrMult)}`,
      resolvedRefresh + autoKey,
    );

    fetchJson<SmcResponse>(path)
      .then((res) => {
        if (cancelled) return;
        setData(res);
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
  }, [resolvedSymbol, resolvedRefresh, interval, atrMult, requestKey]);

  const loading = fetchedFor !== requestKey;

  const activeFvgs = useMemo(
    () =>
      (data?.fvgs ?? [])
        .filter((f) => f.status === "OPEN" || f.status === "PARTIAL")
        .sort((a, b) => a.distance - b.distance),
    [data],
  );

  const headerBar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">
          SMC / ICT & Fair Value Gaps — {data ? data.symbol : resolvedSymbol}
        </h2>
        <p className="text-xs text-zinc-500">
          {data
            ? `${data.data_source === "capital_cfd" ? `● LIVE Capital CFD (${data.feed_symbol ?? ""})` : data.data_source === "alpaca_iex" ? `● LIVE Alpaca IEX (${data.feed_symbol ?? ""} → ${data.yahoo_symbol})` : data.data_source === "alpaca_iex_rest" ? `Alpaca IEX REST (${data.feed_symbol ?? ""} → ${data.yahoo_symbol}) · WebSocket în încălzire` : data.yahoo_symbol} · ${data.interval} · ore RO (Europe/Bucharest)${data.last_bar_time_ro ? ` · ultima bară ${data.last_bar_time_ro}` : ""} · ATR(14) = ${fmt(data.atr, data.symbol)}${data.basis_offset ? ` · XTB offset ${data.basis_offset > 0 ? "+" : ""}${data.basis_offset}` : ""}`
            : `FVG (BISI/SIBI + 50% CE) · Order Blocks · BOS/CHoCH · BSL/SSL · OTE`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={atrMult}
          onChange={(e) => setAtrMult(e.target.value)}
          className="rounded border border-zinc-700 bg-black px-2.5 py-1 text-xs text-zinc-300 outline-none focus:border-amber-500"
          title="Filtru minim mărime FVG raportat la ATR(14)"
        >
          {ATR_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              FVG ≥ {f.label}
            </option>
          ))}
        </select>
        <TimeframeToggle
          value={interval}
          options={SMC_INTERVALS}
          onChange={setIntervalState}
        />
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {headerBar}
        <div className="flex h-[480px] items-center justify-center text-sm text-zinc-500">
          Se încarcă analiza SMC / FVG pentru {resolvedSymbol} ({interval})…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        {headerBar}
        <div className="rounded border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const dr = data.dealing_range;
  const kz = data.killzone;
  const sum = data.summary;

  return (
    <div className="space-y-4">
      {headerBar}

      {/* Top ICT Institutional Summary Cards */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="Structură Piață"
          value={data.structure_trend}
          sub={
            data.last_structure_event
              ? `${data.last_structure_event.type.replace("_", " ")} @ ${fmt(data.last_structure_event.price, data.symbol)} (${data.last_structure_event.ro_time.slice(11)})`
              : "Fără break recent"
          }
          tone={data.structure_trend === "BULLISH" ? "green" : "red"}
        />
        <StatCard
          title="Dealing Range (ICT)"
          value={`${dr.zone} (${dr.position_pct}%)`}
          sub={`EQ 50%: ${fmt(dr.equilibrium, data.symbol)} · [${fmt(dr.range_low, data.symbol)} – ${fmt(dr.range_high, data.symbol)}]`}
          tone={dr.zone === "DISCOUNT" ? "sky" : "amber"}
        />
        <StatCard
          title={`OTE ${dr.ote_direction === "BEARISH" ? "Short" : "Long"} (62–79%)`}
          value={fmt(dr.ote_sweet, data.symbol)}
          sub={`Zonă: ${fmt(dr.ote_low, data.symbol)} – ${fmt(dr.ote_high, data.symbol)}`}
          tone="amber"
        />
        <StatCard
          title="FVG Active (Neparcurse)"
          value={`${sum.open_bull_fvg_count} Bull · ${sum.open_bear_fvg_count} Bear`}
          sub={
            sum.nearest_bear_fvg
              ? `SIBI ↑ CE ${fmt(sum.nearest_bear_fvg.ce, data.symbol)}`
              : sum.nearest_bull_fvg
                ? `BISI ↓ CE ${fmt(sum.nearest_bull_fvg.ce, data.symbol)}`
                : "Niciun FVG activ în apropiere"
          }
          tone="neutral"
        />
        <StatCard
          title="ICT Killzone"
          value={kz.active ? kz.label : "În afara KZ"}
          sub={
            kz.silver_bullet
              ? `${kz.silver_bullet} · ${kz.ro_now} RO`
              : `${kz.window_ro ? `${kz.window_ro} · ` : ""}${kz.ro_now} RO (${kz.ny_now} NY)`
          }
          tone={kz.active ? "green" : "neutral"}
        />
      </div>

      {/* Overlay Layer Toggles */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <TogglePill
          active={showOpenFvg}
          onClick={() => setShowOpenFvg((v) => !v)}
          dotColor="bg-emerald-400"
          label={`FVG Active (${activeFvgs.length})`}
        />
        <TogglePill
          active={showOb}
          onClick={() => setShowOb((v) => !v)}
          dotColor="bg-sky-400"
          label={`Order Blocks (${data.order_blocks.length})`}
        />
        <TogglePill
          active={showStructure}
          onClick={() => setShowStructure((v) => !v)}
          dotColor="bg-amber-400"
          label={`BOS / CHoCH & Sweeps (${data.structure_events.length + data.sweeps.length})`}
        />
        <TogglePill
          active={showLiquidity}
          onClick={() => setShowLiquidity((v) => !v)}
          dotColor="bg-violet-400"
          label="BSL / SSL & EQ 50%"
        />
        <TogglePill
          active={showOte}
          onClick={() => setShowOte((v) => !v)}
          dotColor="bg-yellow-400"
          label="Zonă OTE 62–79%"
        />
        <TogglePill
          active={showMitigatedFvg}
          onClick={() => setShowMitigatedFvg((v) => !v)}
          dotColor="bg-zinc-500"
          label={`FVG Umplute (${sum.mitigated_fvg_count})`}
        />
      </div>

      {/* Main SMC / FVG Candlestick Chart */}
      <SmcPriceChart
        data={data}
        showOpenFvg={showOpenFvg}
        showMitigatedFvg={showMitigatedFvg}
        showOb={showOb}
        showStructure={showStructure}
        showLiquidity={showLiquidity}
        showOte={showOte}
      />

      <p className="text-xs text-zinc-500">
        <strong className="text-emerald-400">BISI (verde)</strong> = Bullish FVG (dezechilibru de cumpărare, suport pe retest) ·{" "}
        <strong className="text-red-400">SIBI (roșu)</strong> = Bearish FVG (dezechilibru de vânzare, rezistență pe retest) ·{" "}
        linia punctată din interiorul FVG = <strong>CE (50% Consequent Encroachment)</strong>.{" "}
        <strong className="text-sky-400">OB+</strong> / <strong className="text-amber-400">OB-</strong> = Order Blocks instituționale.
      </p>

      {/* Tables: Active FVGs + Order Blocks & Liquidity */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <FvgTable fvgs={activeFvgs} symbol={data.symbol} currentPrice={data.current_price} />
        <div className="space-y-4">
          <OrderBlockTable blocks={data.order_blocks} symbol={data.symbol} />
          <LiquidityTable
            bsl={data.liquidity.bsl}
            ssl={data.liquidity.ssl}
            sweeps={data.sweeps}
            symbol={data.symbol}
          />
        </div>
      </div>
    </div>
  );
}

function SmcPriceChart({
  data,
  showOpenFvg,
  showMitigatedFvg,
  showOb,
  showStructure,
  showLiquidity,
  showOte,
}: {
  data: SmcResponse;
  showOpenFvg: boolean;
  showMitigatedFvg: boolean;
  showOb: boolean;
  showStructure: boolean;
  showLiquidity: boolean;
  showOte: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.candles.length === 0) return;

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
      precision: priceDecimals(data.current_price, data.symbol),
      minMove: priceMinMove(data.current_price, data.symbol),
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

    series.setData(
      data.candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const boxes: ZoneBox[] = [];
    const firstTime = data.candles[0].time as UTCTimestamp;
    const lastTime = data.candles[data.candles.length - 1].time as UTCTimestamp;

    if (showOte) {
      const dr = data.dealing_range;
      boxes.push({
        id: "OTE-BAND",
        startTime: firstTime,
        endTime: lastTime,
        extendRight: true,
        top: Math.max(dr.ote_high, dr.ote_low),
        bottom: Math.min(dr.ote_high, dr.ote_low),
        ce: dr.ote_sweet,
        fillColor: "rgba(234, 179, 8, 0.06)",
        borderColor: "rgba(234, 179, 8, 0.35)",
        ceColor: "rgba(250, 204, 21, 0.5)",
        label: `OTE ${dr.ote_direction === "BEARISH" ? "SHORT" : "LONG"}`,
      });
    }

    for (const fvg of data.fvgs) {
      const isOpen = fvg.status === "OPEN" || fvg.status === "PARTIAL";
      if (isOpen && !showOpenFvg) continue;
      if (!isOpen && !showMitigatedFvg) continue;

      const bull = fvg.type === "BULLISH";
      boxes.push({
        id: fvg.id,
        startTime: fvg.time as UTCTimestamp,
        endTime: fvg.end_time as UTCTimestamp,
        extendRight: isOpen,
        top: fvg.top,
        bottom: fvg.bottom,
        ce: isOpen ? fvg.ce : undefined,
        fillColor: isOpen
          ? bull
            ? "rgba(34, 197, 94, 0.17)"
            : "rgba(239, 68, 68, 0.17)"
          : bull
            ? "rgba(34, 197, 94, 0.05)"
            : "rgba(239, 68, 68, 0.05)",
        borderColor: isOpen
          ? bull
            ? "rgba(74, 222, 128, 0.65)"
            : "rgba(248, 113, 113, 0.65)"
          : "rgba(113, 113, 122, 0.3)",
        ceColor: bull ? "rgba(134, 239, 172, 0.7)" : "rgba(252, 165, 165, 0.7)",
        label: isOpen ? `${fvg.label} ${fmt(fvg.ce, data.symbol)}` : undefined,
      });
    }

    if (showOb) {
      for (const ob of data.order_blocks) {
        const bull = ob.type === "BULLISH";
        boxes.push({
          id: ob.id,
          startTime: ob.time as UTCTimestamp,
          endTime: ob.end_time as UTCTimestamp,
          extendRight: true,
          top: ob.top,
          bottom: ob.bottom,
          ce: ob.ce,
          fillColor: bull ? "rgba(14, 165, 233, 0.14)" : "rgba(245, 158, 11, 0.14)",
          borderColor: bull ? "rgba(56, 189, 248, 0.65)" : "rgba(251, 191, 36, 0.65)",
          ceColor: bull ? "rgba(56, 189, 248, 0.45)" : "rgba(251, 191, 36, 0.45)",
          label: bull ? `OB+ ${fmt(ob.ce, data.symbol)}` : `OB- ${fmt(ob.ce, data.symbol)}`,
        });
      }
    }

    const primitive = new SmcZonesPrimitive(boxes);
    series.attachPrimitive(primitive);

    if (showLiquidity) {
      series.createPriceLine({
        price: data.dealing_range.equilibrium,
        title: "EQ 50%",
        color: "#a78bfa",
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
      });

      const nearBsl = data.summary.nearest_bsl;
      if (nearBsl) {
        series.createPriceLine({
          price: nearBsl.price,
          title: `BSL (${nearBsl.kind})`,
          color: "#22c55e",
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          axisLabelVisible: true,
        });
      }

      const nearSsl = data.summary.nearest_ssl;
      if (nearSsl) {
        series.createPriceLine({
          price: nearSsl.price,
          title: `SSL (${nearSsl.kind})`,
          color: "#ef4444",
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          axisLabelVisible: true,
        });
      }

      if (data.dealing_range.pdh != null) {
        series.createPriceLine({
          price: data.dealing_range.pdh,
          title: "PDH",
          color: "#71717a",
          lineStyle: LineStyle.SparseDotted,
          lineWidth: 1,
          axisLabelVisible: true,
        });
      }
      if (data.dealing_range.pdl != null) {
        series.createPriceLine({
          price: data.dealing_range.pdl,
          title: "PDL",
          color: "#71717a",
          lineStyle: LineStyle.SparseDotted,
          lineWidth: 1,
          axisLabelVisible: true,
        });
      }
    }

    if (showStructure) {
      const candleTimes = new Set(data.candles.map((c) => c.time));
      const structMarkers = data.structure_events
        .filter((ev) => candleTimes.has(ev.time))
        .map((ev) => {
          const bull = ev.direction === "BULLISH";
          const isChoch = ev.type.startsWith("CHOCH");
          return {
            time: ev.time as UTCTimestamp,
            position: bull ? ("belowBar" as const) : ("aboveBar" as const),
            color: isChoch ? "#fbbf24" : bull ? "#22c55e" : "#ef4444",
            shape: bull ? ("arrowUp" as const) : ("arrowDown" as const),
            text: isChoch ? (bull ? "CHoCH↑" : "CHoCH↓") : bull ? "BOS↑" : "BOS↓",
          };
        });

      const sweepMarkers = data.sweeps
        .filter((sw) => candleTimes.has(sw.time))
        .map((sw) => {
          const bull = sw.type === "BULLISH_SWEEP";
          return {
            time: sw.time as UTCTimestamp,
            position: bull ? ("belowBar" as const) : ("aboveBar" as const),
            color: bull ? "#38bdf8" : "#f472b6",
            shape: "circle" as const,
            text: bull ? "SSL SWP" : "BSL SWP",
          };
        });

      const allMarkers = [...structMarkers, ...sweepMarkers].sort(
        (a, b) => Number(a.time) - Number(b.time),
      );
      if (allMarkers.length > 0) {
        createSeriesMarkers(series, allMarkers);
      }
    }

    chart.timeScale().fitContent();

    return () => {
      series.detachPrimitive(primitive);
      chart.remove();
    };
  }, [
    data,
    showOpenFvg,
    showMitigatedFvg,
    showOb,
    showStructure,
    showLiquidity,
    showOte,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-[480px] w-full overflow-hidden rounded border border-zinc-800"
    />
  );
}

function FvgTable({
  fvgs,
  symbol,
  currentPrice,
}: {
  fvgs: SmcFvg[];
  symbol: string;
  currentPrice: number;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-black/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
          Fair Value Gaps Active (ordonate după apropierea de preț)
        </h3>
        <span className="font-mono text-[11px] text-zinc-500">
          Preț: {fmt(currentPrice, symbol)}
        </span>
      </div>
      {fvgs.length === 0 ? (
        <p className="py-6 text-center text-xs text-zinc-500">
          Niciun FVG neparcurs pe acest timeframe și filtru ATR.
        </p>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-[10px] uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-2 py-1.5">Tip</th>
                <th className="px-2 py-1.5">Zonă (Bottom – Top)</th>
                <th className="px-2 py-1.5">CE (50%)</th>
                <th className="px-2 py-1.5">Mărime</th>
                <th className="px-2 py-1.5">Distanță</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Ora RO</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900 font-mono">
              {fvgs.map((f) => {
                const bull = f.type === "BULLISH";
                const inside = currentPrice >= f.bottom && currentPrice <= f.top;
                return (
                  <tr
                    key={f.id}
                    className={inside ? "bg-amber-500/10" : "hover:bg-zinc-900/50"}
                  >
                    <td className="px-2 py-1.5 font-sans">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          bull
                            ? "bg-emerald-500/15 text-emerald-300"
                            : "bg-red-500/15 text-red-300"
                        }`}
                      >
                        {bull ? "Bull BISI" : "Bear SIBI"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-zinc-200">
                      {fmt(f.bottom, symbol)} – {fmt(f.top, symbol)}
                    </td>
                    <td className="px-2 py-1.5 text-amber-300">
                      {fmt(f.ce, symbol)}
                    </td>
                    <td className="px-2 py-1.5 text-zinc-400">
                      {fmt(f.size, symbol)}{" "}
                      <span className="text-[10px] text-zinc-500">({f.atr_mult}×)</span>
                    </td>
                    <td className="px-2 py-1.5 text-zinc-300">
                      {inside ? (
                        <span className="text-amber-400">ÎN ZONĂ</span>
                      ) : (
                        `${fmt(f.distance, symbol)} pt`
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-sans text-[11px]">
                      {f.status === "OPEN" ? (
                        <span className="text-emerald-400">OPEN (neatins)</span>
                      ) : (
                        <span className="text-amber-300">
                          PARTIAL {f.fill_pct}%{f.ce_touched ? " · CE atins" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[11px] text-zinc-500">
                      {f.ro_time.slice(5)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrderBlockTable({
  blocks,
  symbol,
}: {
  blocks: SmcOrderBlock[];
  symbol: string;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-black/50 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
        Order Blocks Instituționale Active (OB)
      </h3>
      {blocks.length === 0 ? (
        <p className="py-3 text-xs text-zinc-500">Niciun Order Block activ neinvalidat.</p>
      ) : (
        <table className="min-w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-2 py-1">Tip</th>
              <th className="px-2 py-1">Zonă</th>
              <th className="px-2 py-1">Mean (50%)</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Ora RO</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 font-mono">
            {blocks.map((b) => {
              const bull = b.type === "BULLISH";
              return (
                <tr key={b.id}>
                  <td className="px-2 py-1.5 font-sans">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        bull
                          ? "bg-sky-500/15 text-sky-300"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {bull ? "Bull OB+" : "Bear OB-"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-zinc-200">
                    {fmt(b.bottom, symbol)} – {fmt(b.top, symbol)}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-300">{fmt(b.ce, symbol)}</td>
                  <td className="px-2 py-1.5 font-sans text-[11px] text-zinc-400">
                    {b.status}
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-zinc-500">
                    {b.ro_time.slice(5)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function LiquidityTable({
  bsl,
  ssl,
  sweeps,
  symbol,
}: {
  bsl: SmcLiquidityLevel[];
  ssl: SmcLiquidityLevel[];
  sweeps: SmcResponse["sweeps"];
  symbol: string;
}) {
  const rows = [...bsl.slice(0, 3), ...ssl.slice(0, 3)];
  return (
    <div className="rounded border border-zinc-800 bg-black/50 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
        Piscine de Lichiditate (BSL ↑ / SSL ↓) & Ultimul Sweep
      </h3>
      {rows.length === 0 ? (
        <p className="py-2 text-xs text-zinc-500">Fără niveluri BSL/SSL apropiate.</p>
      ) : (
        <table className="min-w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-2 py-1">Parte</th>
              <th className="px-2 py-1">Tip</th>
              <th className="px-2 py-1">Nivel</th>
              <th className="px-2 py-1">Distanță</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 font-mono">
            {rows.map((r, i) => (
              <tr key={`${r.side}-${r.kind}-${r.price}-${i}`}>
                <td className="px-2 py-1 font-sans">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.side === "BSL"
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-red-500/15 text-red-300"
                    }`}
                  >
                    {r.side}
                  </span>
                </td>
                <td className="px-2 py-1 font-sans text-[11px] text-zinc-300">
                  {r.kind}
                  {r.touches > 1 ? ` (${r.touches}×)` : ""}
                </td>
                <td className="px-2 py-1 text-zinc-100">{fmt(r.price, symbol)}</td>
                <td className="px-2 py-1 text-zinc-400">{fmt(r.distance, symbol)} pt</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {sweeps.length > 0 && (
        <div className="mt-2.5 border-t border-zinc-800/80 pt-2 text-[11px] text-zinc-400">
          <span className="text-zinc-500">Ultimul Liquidity Sweep: </span>
          {(() => {
            const last = sweeps[sweeps.length - 1];
            const bull = last.type === "BULLISH_SWEEP";
            return (
              <span className={bull ? "text-sky-300" : "text-pink-300"}>
                {last.label} @ {fmt(last.price, symbol)} (wick {fmt(last.wick, symbol)}) ·{" "}
                {last.ro_time.slice(5)} RO
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  sub,
  tone,
}: {
  title: string;
  value: string;
  sub: string;
  tone: "green" | "red" | "amber" | "sky" | "neutral";
}) {
  const border =
    tone === "green"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
      : tone === "red"
        ? "border-red-500/30 bg-red-500/5 text-red-300"
        : tone === "amber"
          ? "border-amber-500/30 bg-amber-500/5 text-amber-300"
          : tone === "sky"
            ? "border-sky-500/30 bg-sky-500/5 text-sky-300"
            : "border-zinc-800 bg-zinc-900/40 text-zinc-200";
  return (
    <div className={`rounded border px-3 py-2 ${border}`}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-zinc-400" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function TogglePill({
  active,
  onClick,
  dotColor,
  label,
}: {
  active: boolean;
  onClick: () => void;
  dotColor: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 transition ${
        active
          ? "border-zinc-600 bg-zinc-900 text-zinc-100"
          : "border-zinc-800 bg-black text-zinc-500 hover:text-zinc-300"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${active ? dotColor : "bg-zinc-700"}`} />
      {label}
    </button>
  );
}
