"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
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
import type { SmcFvg, SmcLiquidityLevel, SmcResponse } from "@/lib/api";
import { fmtPriceFor, isFxSymbol, priceDecimals } from "@/lib/format";

type ZoneBox = {
  id: string;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
  top: number;
  bottom: number;
  ce?: number;
  fillColor: string;
  borderColor: string;
};

class ZonesRenderer implements IPrimitivePaneRenderer {
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
        const yTop = series.priceToCoordinate(box.top);
        const yBot = series.priceToCoordinate(box.bottom);
        if (yTop == null || yBot == null) continue;
        const y1 = Math.min(yTop, yBot);
        const y2 = Math.max(yTop, yBot);
        if (y2 < 0 || y1 > height) continue;
        const xStart = timeScale.timeToCoordinate(box.startTime);
        const xEnd = timeScale.timeToCoordinate(box.endTime);
        const x1 = Math.max(0, xStart != null ? Number(xStart) : 0);
        const x2 = Math.min(width, xEnd != null ? Number(xEnd) : width);
        if (x2 - x1 < 2) continue;
        context.save();
        context.fillStyle = box.fillColor;
        context.fillRect(x1, y1, x2 - x1, Math.max(1.5, y2 - y1));
        context.strokeStyle = box.borderColor;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y1);
        context.moveTo(x1, y2);
        context.lineTo(x2, y2);
        context.stroke();
        if (box.ce != null && y2 - y1 >= 6) {
          const yCe = series.priceToCoordinate(box.ce);
          if (yCe != null && yCe >= y1 && yCe <= y2) {
            context.strokeStyle = box.borderColor;
            context.setLineDash([4, 4]);
            context.beginPath();
            context.moveTo(x1, yCe);
            context.lineTo(x2, yCe);
            context.stroke();
            context.setLineDash([]);
          }
        }
        context.restore();
      }
    });
  }
}

class ZonesView implements IPrimitivePaneView {
  private readonly _source: ZonesPrimitive;
  constructor(source: ZonesPrimitive) {
    this._source = source;
  }
  update(): void {}
  renderer(): IPrimitivePaneRenderer {
    return new ZonesRenderer(this._source.boxes, this._source.attachedParam);
  }
}

class ZonesPrimitive implements ISeriesPrimitive<Time> {
  boxes: ZoneBox[];
  attachedParam: SeriesAttachedParameter<Time> | null = null;
  private _views: ZonesView[];

  constructor(boxes: ZoneBox[]) {
    this.boxes = boxes;
    this._views = [new ZonesView(this)];
  }
  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedParam = param;
    param.requestUpdate();
  }
  detached(): void {
    this.attachedParam = null;
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return this._views;
  }
  updateAllViews(): void {}
}

export type IctChartPlan = {
  bias: string;
  score: number;
  bullFvgBelow: SmcFvg | null;
  bearFvgAbove: SmcFvg | null;
  longEntry: number | null;
  longStop: number | null;
  longT1: number | null;
  longT2: number | null;
  shortEntry: number | null;
  shortStop: number | null;
  shortT1: number | null;
  shortT2: number | null;
  nearestBsl: SmcLiquidityLevel | null;
  nearestSsl: SmcLiquidityLevel | null;
  /** Trendul structurii pe 15m și 1h: planul e confirmat doar dacă ambele au direcția lui. */
  trend15m: string;
  trend1h: string;
  /** Limita de distanță a zonei de intrare (multiplu de ATR 5m și valoarea în puncte). */
  maxEntryAtr: number;
  maxEntryDist: number;
  /** Cel mai apropiat FVG respins de limita de distanță, pe fiecare parte. */
  farBull: SmcFvg | null;
  farBear: SmcFvg | null;
  farBullDist: number | null;
  farBearDist: number | null;
};

type Props = {
  symbol: string;
  exec: SmcResponse;
  plan: IctChartPlan;
};

function fmt(n: number | null | undefined, symbol: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return isFxSymbol(symbol) ? fmtPriceFor(n, symbol) : n.toFixed(priceDecimals(n, symbol));
}

const STEP_SEC = 300; // panoul ICT folosește execuția 5m
const HORIZON_BARS = 24; // proiecție ~2h

export default function IctForecastChart({ symbol, exec, plan }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Direcția preferată: bias-ul ICT când e clar; la bias MIXT, direcția pe care
  // 15m și 1h o au în comun (dacă sunt de acord), altfel trendul de execuție 5m.
  // Dacă partea preferată nu are zonă de intrare în rază, se încearcă cealaltă
  // (care va ieși marcată „contra trend” dacă 15m/1h nu o confirmă).
  const htfDir = plan.trend15m === plan.trend1h ? plan.trend15m : null;
  const preferredDir =
    plan.bias === "BULLISH" || plan.bias === "BEARISH"
      ? plan.bias
      : (htfDir ?? exec.structure_trend);
  const isLong =
    preferredDir === "BULLISH" ? plan.longEntry != null : plan.shortEntry == null;
  const entry = isLong ? plan.longEntry : plan.shortEntry;
  const stop = isLong ? plan.longStop : plan.shortStop;
  const t1 = isLong ? plan.longT1 : plan.shortT1;
  const t2 = isLong ? plan.longT2 : plan.shortT2;
  const fvg = isLong ? plan.bullFvgBelow : plan.bearFvgAbove;
  const directionLabel = isLong ? "LONG" : "SHORT";
  // Filtru de timeframe superior: zonele de stop/ieșire și traiectoria apar doar
  // când 15m și 1h au direcția planului; altfel zona rămâne gri, „contra trend”.
  const planDir = isLong ? "BULLISH" : "BEARISH";
  const confirmed = plan.trend15m === planDir && plan.trend1h === planDir;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || entry == null || stop == null || !fvg) return;

    const candles = exec.candles.slice(-140);
    if (candles.length < 10) return;
    const last = candles[candles.length - 1];
    const lastTime = last.time as UTCTimestamp;
    const price = exec.current_price;
    const atr = Math.max(exec.atr, 1e-9);
    const futureEnd = (lastTime + HORIZON_BARS * STEP_SEC) as UTCTimestamp;

    const chart = createChart(el, {
      height: 380,
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(63,63,70,0.35)" },
        horzLines: { color: "rgba(63,63,70,0.35)" },
      },
      rightPriceScale: { borderColor: "#3f3f46" },
      timeScale: { borderColor: "#3f3f46", timeVisible: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
      borderVisible: false,
      priceFormat: {
        type: "price",
        precision: priceDecimals(price, symbol),
        minMove: 1 / 10 ** priceDecimals(price, symbol),
      },
    });
    candleSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // ── Zone: intrare (FVG), stop (dincolo de FVG), ieșiri TP1/TP2 ──────────
    const zoneColor = !confirmed
      ? "rgba(161,161,170,"
      : isLong
        ? "rgba(34,197,94,"
        : "rgba(239,68,68,";
    const boxes: ZoneBox[] = [
      {
        id: "entry",
        startTime: fvg.time as UTCTimestamp,
        endTime: futureEnd,
        top: fvg.top,
        bottom: fvg.bottom,
        ce: fvg.ce,
        fillColor: `${zoneColor}${confirmed ? "0.16" : "0.10"})`,
        borderColor: `${zoneColor}${confirmed ? "0.75" : "0.6"})`,
      },
    ];
    if (confirmed) {
      boxes.push({
        id: "stop",
        startTime: lastTime,
        endTime: futureEnd,
        top: isLong ? fvg.bottom : stop,
        bottom: isLong ? stop : fvg.top,
        fillColor: "rgba(239,68,68,0.13)",
        borderColor: "rgba(239,68,68,0.55)",
      });
    }
    if (confirmed && t1 != null) {
      boxes.push({
        id: "tp1",
        startTime: lastTime,
        endTime: futureEnd,
        top: t1 + 0.12 * atr,
        bottom: t1 - 0.12 * atr,
        fillColor: "rgba(56,189,248,0.15)",
        borderColor: "rgba(56,189,248,0.7)",
      });
    }
    if (confirmed && t2 != null && t2 !== t1) {
      boxes.push({
        id: "tp2",
        startTime: lastTime,
        endTime: futureEnd,
        top: t2 + 0.12 * atr,
        bottom: t2 - 0.12 * atr,
        fillColor: "rgba(56,189,248,0.10)",
        borderColor: "rgba(56,189,248,0.45)",
      });
    }
    candleSeries.attachPrimitive(new ZonesPrimitive(boxes));

    if (confirmed) {
      // ── Traiectorie proiectată: preț → CE intrare → TP1 → TP2 ─────────────
      const entryBars = Math.max(3, Math.min(8, Math.round(Math.abs(price - entry) / (0.55 * atr)) + 3));
      const waypoints: Array<{ bars: number; price: number }> = [
        { bars: 0, price },
        { bars: entryBars, price: entry },
        { bars: Math.round(HORIZON_BARS * 0.62), price: t1 ?? entry },
        { bars: HORIZON_BARS, price: t2 ?? t1 ?? entry },
      ];
      const path: Array<{ time: UTCTimestamp; value: number }> = [];
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        const span = Math.max(1, b.bars - a.bars);
        for (let s = i === 0 ? 0 : 1; s <= span; s++) {
          const k = s / span;
          const ease = 0.5 - 0.5 * Math.cos(Math.PI * k);
          path.push({
            time: (lastTime + (a.bars + s) * STEP_SEC) as UTCTimestamp,
            value: a.price + (b.price - a.price) * ease,
          });
        }
      }
      const projSeries = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      projSeries.setData(path);
      createSeriesMarkers(projSeries, [
        {
          time: (lastTime + entryBars * STEP_SEC) as UTCTimestamp,
          position: isLong ? "belowBar" : "aboveBar",
          shape: isLong ? "arrowUp" : "arrowDown",
          color: isLong ? "#22c55e" : "#ef4444",
          text: `INTRARE CE ${fmt(entry, symbol)}`,
        },
        ...(t1 != null
          ? [
              {
                time: (lastTime + Math.round(HORIZON_BARS * 0.62) * STEP_SEC) as UTCTimestamp,
                position: isLong ? ("aboveBar" as const) : ("belowBar" as const),
                shape: "circle" as const,
                color: "#38bdf8",
                text: `TP1 ${fmt(t1, symbol)}`,
              },
            ]
          : []),
      ]);

      candleSeries.createPriceLine({
        price: stop,
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `STOP ${fmt(stop, symbol)}`,
      });
      if (t2 != null) {
        candleSeries.createPriceLine({
          price: t2,
          color: "#38bdf8",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: `TP2 ${fmt(t2, symbol)}`,
        });
      }
    } else {
      candleSeries.createPriceLine({
        price: fvg.ce,
        color: "#a1a1aa",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `CONTRA TREND ${directionLabel} CE ${fmt(fvg.ce, symbol)}`,
      });
    }

    chart.timeScale().fitContent();
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) chart.applyOptions({ width: w });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [symbol, exec, entry, stop, t1, t2, fvg, isLong, confirmed, directionLabel]);

  if (entry == null || stop == null || !fvg) {
    const far = [
      plan.farBear && plan.farBearDist != null
        ? `SIBI ${fmt(plan.farBear.bottom, symbol)}–${fmt(plan.farBear.top, symbol)} la ${fmt(plan.farBearDist, symbol)} pt`
        : null,
      plan.farBull && plan.farBullDist != null
        ? `BISI ${fmt(plan.farBull.bottom, symbol)}–${fmt(plan.farBull.top, symbol)} la ${fmt(plan.farBullDist, symbol)} pt`
        : null,
    ].filter((s): s is string => s != null);
    return (
      <div className="rounded border border-zinc-800 bg-black/30 px-3 py-2 text-xs leading-relaxed text-zinc-500">
        Grafic forecast ICT indisponibil: niciun FVG activ la cel mult {plan.maxEntryAtr}×ATR(5m) (
        {fmt(plan.maxEntryDist, symbol)} pt) de preț, deci nu există zonă de intrare.
        {far.length > 0 ? ` Cele mai apropiate, în afara limitei: ${far.join(" · ")}.` : ""}
      </div>
    );
  }

  const risk = Math.abs(entry - stop);
  const rr1 = t1 != null && risk > 0 ? Math.abs(t1 - entry) / risk : null;
  const rr2 = t2 != null && risk > 0 ? Math.abs(t2 - entry) / risk : null;

  return (
    <div className="space-y-2">
      <div ref={containerRef} className="w-full overflow-hidden rounded border border-zinc-800" />
      {!confirmed && (
        <p className="text-[11px] leading-relaxed text-zinc-400">
          <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 font-semibold text-red-300">
            CONTRA TREND
          </span>{" "}
          {directionLabel} nu e confirmat de timeframe-urile superioare: 15m{" "}
          <span className={plan.trend15m === planDir ? "text-emerald-400" : "text-red-400"}>
            {plan.trend15m}
          </span>{" "}
          · 1h{" "}
          <span className={plan.trend1h === planDir ? "text-emerald-400" : "text-red-400"}>{plan.trend1h}</span>.
          Planul (stop, ieșiri, traiectorie) nu se afișează; rămâne doar zona, cu gri. Niveluri orientative: CE{" "}
          {fmt(entry, symbol)} în FVG {fmt(fvg.bottom, symbol)}–{fmt(fvg.top, symbol)} · stop {fmt(stop, symbol)}.
        </p>
      )}
      {confirmed && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] leading-relaxed text-zinc-400">
          <span>
            <span className={isLong ? "text-emerald-400" : "text-red-400"}>
              ● Zonă intrare {directionLabel}
            </span>{" "}
            {fmt(fvg.bottom, symbol)}–{fmt(fvg.top, symbol)} (CE {fmt(fvg.ce, symbol)})
          </span>
          <span>
            <span className="text-red-400">● Stop</span> {fmt(stop, symbol)} (risc {fmt(risk, symbol)} pt)
          </span>
          <span>
            <span className="text-sky-400">● Ieșiri</span> TP1 {fmt(t1, symbol)}
            {rr1 != null ? ` (${rr1.toFixed(1)}R)` : ""} · TP2 {fmt(t2, symbol)}
            {rr2 != null ? ` (${rr2.toFixed(1)}R)` : ""}
          </span>
          <span className="text-amber-400">
            - - Traiectorie proiectată din SMC (preț → retest FVG → lichiditate), confirmată de 15m și 1h.
            Proiecție, nu semnal garantat.
          </span>
        </div>
      )}
    </div>
  );
}
