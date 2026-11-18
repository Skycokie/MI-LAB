"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Crosshair,
  Landmark,
  Newspaper,
  Waves,
} from "lucide-react";
import {
  fetchJson,
  withRefresh,
  type ForecastCandle,
  type SmcFvg,
  type SmcLiquidityLevel,
  type SmcResponse,
  type SmcStructureEvent,
} from "@/lib/api";
import { useLab } from "@/context/LabContext";
import { fmtPriceFor, isFxSymbol, priceDecimals } from "@/lib/format";
import IctForecastChart from "@/components/IctForecastChart";

type Props = {
  symbol: string;
  kronosInterval: string;
  kronosHistory?: ForecastCandle[];
  kronosForecast?: ForecastCandle[];
  refreshKey: number;
};

type Loaded = {
  exec: SmcResponse;
  confirm: SmcResponse;
  htf: SmcResponse;
};

type PostBreak = {
  event: SmcStructureEvent;
  fvg: SmcFvg;
  tf: string;
};

const TF_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };

function fmt(n: number | null | undefined, symbol: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return isFxSymbol(symbol) ? fmtPriceFor(n, symbol) : n.toFixed(priceDecimals(n, symbol));
}

function signed(n: number, symbol: string): string {
  return `${n >= 0 ? "+" : ""}${fmt(n, symbol)}`;
}

function isUs100(symbol: string): boolean {
  return ["US100", "NAS100", "USTECH", "NQ=F", "QQQ", "NDX", "^NDX"].includes(
    symbol.toUpperCase(),
  );
}

function activeFvgs(data: SmcResponse): SmcFvg[] {
  return data.fvgs.filter((f) => f.status === "OPEN" || f.status === "PARTIAL");
}

function findPostBreakFvg(data: SmcResponse, tf: string): PostBreak | null {
  const sec = TF_SEC[tf] ?? 300;
  const events = [...data.structure_events].reverse();
  const fvgs = activeFvgs(data);
  for (const event of events) {
    const aligned = fvgs
      .filter(
        (f) =>
          f.type === event.direction &&
          f.impulse_time >= event.time &&
          f.impulse_time <= event.time + 6 * sec,
      )
      .sort((a, b) => Number(b.displaced) - Number(a.displaced) || a.distance - b.distance);
    if (aligned[0]) return { event, fvg: aligned[0], tf };
  }
  return null;
}

function nearestAboveFvg(data: SmcResponse, price: number): SmcFvg | null {
  return (
    activeFvgs(data)
      .filter((f) => f.type === "BEARISH" && f.top >= price)
      .sort((a, b) => a.bottom - b.bottom)[0] ?? null
  );
}

function nearestBelowFvg(data: SmcResponse, price: number): SmcFvg | null {
  return (
    activeFvgs(data)
      .filter((f) => f.type === "BULLISH" && f.bottom <= price)
      .sort((a, b) => b.top - a.top)[0] ?? null
  );
}

function preferEq(levels: SmcLiquidityLevel[], eqKind: "EQH" | "EQL"): SmcLiquidityLevel | null {
  return levels.find((l) => l.kind === eqKind) ?? null;
}

export default function IctForecastPanel({
  symbol,
  kronosInterval,
  kronosHistory,
  kronosForecast,
  refreshKey,
}: Props) {
  const { openSymbol } = useLab();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedFor, setFetchedFor] = useState<string | null>(null);
  // Auto-refresh la 30s: nivelurile ICT urmăresc bara live (Alpaca WebSocket).
  const [autoKey, setAutoKey] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAutoKey((k) => k + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const requestKey = `${symbol}|${refreshKey}|${autoKey}`;

  useEffect(() => {
    let cancelled = false;
    const loadOne = (tf: string) =>
      fetchJson<SmcResponse>(
        withRefresh(
          `/api/smc/${encodeURIComponent(symbol)}?interval=${tf}&bars=240&min_atr_mult=0.15`,
          refreshKey + autoKey,
        ),
      );
    Promise.all([loadOne("5m"), loadOne("15m"), loadOne("1h")])
      .then(([exec, confirm, htf]) => {
        if (cancelled) return;
        setLoaded({ exec, confirm, htf });
        setError(null);
        setFetchedFor(requestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoaded(null);
        setFetchedFor(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, refreshKey, requestKey]);

  const model = useMemo(() => {
    if (!loaded) return null;
    const { exec, confirm, htf } = loaded;
    const price = exec.current_price;

    const postBreak =
      findPostBreakFvg(confirm, "15m") ?? findPostBreakFvg(exec, "5m");
    const bullFvgBelow =
      postBreak?.fvg.type === "BULLISH" ? postBreak.fvg : nearestBelowFvg(confirm, price) ?? nearestBelowFvg(exec, price);
    const bearFvgAbove =
      postBreak?.fvg.type === "BEARISH" ? postBreak.fvg : nearestAboveFvg(confirm, price) ?? nearestAboveFvg(exec, price);

    const bslLevels = confirm.liquidity.bsl.length ? confirm.liquidity.bsl : exec.liquidity.bsl;
    const sslLevels = confirm.liquidity.ssl.length ? confirm.liquidity.ssl : exec.liquidity.ssl;
    const nearestBsl = bslLevels[0] ?? null;
    const nearestSsl = sslLevels[0] ?? null;
    const eqh = preferEq(bslLevels, "EQH");
    const eql = preferEq(sslLevels, "EQL");
    const latestSweep = exec.sweeps.at(-1) ?? confirm.sweeps.at(-1) ?? null;

    // Kronos path: direction + which ICT level is projected to be visited first.
    const kStart = kronosHistory?.at(-1)?.close ?? price;
    const kEnd = kronosForecast?.at(-1)?.close ?? null;
    const kHigh = kronosForecast?.length ? Math.max(...kronosForecast.map((c) => c.high)) : null;
    const kLow = kronosForecast?.length ? Math.min(...kronosForecast.map((c) => c.low)) : null;
    const kChange = kEnd != null ? kEnd - kStart : null;
    let kFirst: string | null = null;
    if (kronosForecast?.length) {
      for (const [idx, c] of kronosForecast.entries()) {
        if (nearestBsl && c.high >= nearestBsl.price) {
          kFirst = `BSL ${fmt(nearestBsl.price, symbol)} (bara Kronos #${idx + 1})`;
          break;
        }
        if (nearestSsl && c.low <= nearestSsl.price) {
          kFirst = `SSL ${fmt(nearestSsl.price, symbol)} (bara Kronos #${idx + 1})`;
          break;
        }
        if (
          bullFvgBelow &&
          c.low <= bullFvgBelow.top &&
          c.high >= bullFvgBelow.bottom
        ) {
          kFirst = `retest BISI ${fmt(bullFvgBelow.bottom, symbol)}–${fmt(bullFvgBelow.top, symbol)} (bara Kronos #${idx + 1})`;
          break;
        }
        if (
          bearFvgAbove &&
          c.low <= bearFvgAbove.top &&
          c.high >= bearFvgAbove.bottom
        ) {
          kFirst = `retest SIBI ${fmt(bearFvgAbove.bottom, symbol)}–${fmt(bearFvgAbove.top, symbol)} (bara Kronos #${idx + 1})`;
          break;
        }
      }
    }

    // ICT bias score — structure + sweep + post-break imbalance. Kronos is only a path filter.
    let score = 0;
    const reasons: string[] = [];
    const dirScore = (trend: string, w: number, label: string) => {
      const s = trend === "BULLISH" ? w : -w;
      score += s;
      reasons.push(`${label} ${trend === "BULLISH" ? "bullish" : "bearish"} (${s >= 0 ? "+" : ""}${s.toFixed(1)})`);
    };
    dirScore(htf.structure_trend, 2, "1h");
    dirScore(confirm.structure_trend, 1.5, "15m");
    dirScore(exec.structure_trend, 1, "5m");
    if (latestSweep) {
      const s = latestSweep.type === "BULLISH_SWEEP" ? 1 : -1;
      score += s;
      reasons.push(`${latestSweep.label} recent (${s >= 0 ? "+" : ""}${s.toFixed(1)})`);
    }
    if (postBreak) {
      const s = postBreak.fvg.type === "BULLISH" ? 1 : -1;
      score += s;
      reasons.push(`FVG după ${postBreak.event.type.replace("_", " ")} pe ${postBreak.tf} (${s >= 0 ? "+" : ""}${s.toFixed(1)})`);
    }
    if (kChange != null && Math.abs(kChange) >= 0.35 * confirm.atr) {
      const s = kChange > 0 ? 0.5 : -0.5;
      score += s;
      reasons.push(`Kronos ${signed(kChange, symbol)} pt (${s >= 0 ? "+" : ""}${s.toFixed(1)})`);
    }

    const bias = score >= 3 ? "BULLISH" : score <= -3 ? "BEARISH" : "MIXT / CONTRATENDINȚĂ";
    const aligned = htf.structure_trend === confirm.structure_trend && confirm.structure_trend === exec.structure_trend;

    // Concrete ICT plans from real imbalance / liquidity levels.
    // US100 sweeps routinely overshoot a level by a fraction of the 15m ATR,
    // so the stop buffer uses the confirmation timeframe, not just 5m noise.
    const stopPad = Math.max(0.5 * exec.atr, 0.35 * confirm.atr);
    const longEntry = bullFvgBelow?.ce ?? null;
    const longStop = bullFvgBelow
      ? bullFvgBelow.bottom - Math.max(stopPad, bullFvgBelow.size * 0.2)
      : null;
    const longRisk = longEntry != null && longStop != null ? longEntry - longStop : null;
    const execBsl = exec.summary.nearest_bsl?.price ?? null;
    const longT1 =
      execBsl != null && longEntry != null && execBsl > longEntry
        ? execBsl
        : (nearestBsl?.price ?? bearFvgAbove?.ce ?? null);
    const longT2 = eqh?.price ?? nearestBsl?.price ?? bearFvgAbove?.ce ?? null;
    const longRr1 = longRisk && longT1 != null ? (longT1 - (longEntry ?? 0)) / longRisk : null;
    const longRr2 = longRisk && longT2 != null ? (longT2 - (longEntry ?? 0)) / longRisk : null;

    const shortEntry = bearFvgAbove?.ce ?? null;
    const shortStop = bearFvgAbove
      ? bearFvgAbove.top + Math.max(stopPad, bearFvgAbove.size * 0.2)
      : null;
    const shortRisk = shortEntry != null && shortStop != null ? shortStop - shortEntry : null;
    // T1 = nearest execution-timeframe liquidity; T2 = confirmation-timeframe target.
    const execSsl = exec.summary.nearest_ssl?.price ?? null;
    const shortT1 =
      execSsl != null && shortEntry != null && execSsl < shortEntry
        ? execSsl
        : (nearestSsl?.price ?? bullFvgBelow?.ce ?? null);
    const shortT2 = eql?.price ?? nearestSsl?.price ?? bullFvgBelow?.bottom ?? null;
    const shortRr1 = shortRisk && shortT1 != null ? ((shortEntry ?? 0) - shortT1) / shortRisk : null;
    const shortRr2 = shortRisk && shortT2 != null ? ((shortEntry ?? 0) - shortT2) / shortRisk : null;

    const projectedRange = kHigh != null && kLow != null ? kHigh - kLow : null;

    return {
      price,
      postBreak,
      bullFvgBelow,
      bearFvgAbove,
      nearestBsl,
      nearestSsl,
      eqh,
      eql,
      latestSweep,
      kStart,
      kEnd,
      kHigh,
      kLow,
      kChange,
      kFirst,
      score,
      reasons,
      bias,
      aligned,
      longEntry,
      longStop,
      longT1,
      longT2,
      longRr1,
      longRr2,
      shortEntry,
      shortStop,
      shortT1,
      shortT2,
      shortRr1,
      shortRr2,
      projectedRange,
    };
  }, [loaded, kronosForecast, kronosHistory, symbol]);

  if (fetchedFor !== requestKey) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="text-sm text-zinc-500">Se încarcă ICT Forecast (FVG · sweep-uri · lichiditate)…</p>
      </section>
    );
  }

  if (error || !loaded || !model) {
    return (
      <section className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        ICT Forecast indisponibil: {error ?? "date SMC insuficiente"}
      </section>
    );
  }

  const { exec, confirm, htf } = loaded;
  const tech = isUs100(symbol);
  const biasTone =
    model.bias === "BULLISH"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : model.bias === "BEARISH"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-amber-500/30 bg-amber-500/10 text-amber-300";

  return (
    <section className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="inline-flex items-center gap-2 text-base font-semibold text-zinc-100">
            <Crosshair className="h-5 w-5 text-amber-400" />
            ICT Forecast — după Kronos: dezechilibre, sweep-uri, lichiditate
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-500">
            Kronos dă doar o traiectorie probabilistică. Forecast-ul ICT o filtrează prin structură:
            întâi unde e lichiditatea (EQH/EQL, BSL/SSL), apoi dacă prețul revine în FVG-ul format după
            BOS/CHoCH. Fără linii de trend și fără intrare la mijlocul range-ului.
            {exec.data_source === "capital_cfd" && (
              <span className="text-emerald-400">
                {" "}
                ● Date ICT live Capital CFD ({exec.feed_symbol}), ultima bară{" "}
                {exec.last_bar_time_ro ?? "—"} RO.
              </span>
            )}
            {exec.data_source === "alpaca_iex" && (
              <span className="text-emerald-400">
                {" "}
                ● Date ICT live Alpaca IEX ({exec.feed_symbol} → {exec.yahoo_symbol}), ultima bară{" "}
                {exec.last_bar_time_ro ?? "—"} RO.
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => openSymbol(symbol, "news")}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition hover:border-amber-500/60 hover:text-amber-300"
        >
          <Newspaper className="h-3.5 w-3.5" /> Verifică știrile / macro
        </button>
      </div>

      <IctForecastChart
        symbol={symbol}
        exec={exec}
        plan={{
          bias: model.bias,
          score: model.score,
          bullFvgBelow: model.bullFvgBelow,
          bearFvgAbove: model.bearFvgAbove,
          longEntry: model.longEntry,
          longStop: model.longStop,
          longT1: model.longT1,
          longT2: model.longT2,
          shortEntry: model.shortEntry,
          shortStop: model.shortStop,
          shortT1: model.shortT1,
          shortT2: model.shortT2,
          nearestBsl: model.nearestBsl,
          nearestSsl: model.nearestSsl,
        }}
      />

      <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-5">
        <div className={`rounded border px-3 py-2 ${biasTone}`}>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Bias ICT multi-TF</div>
          <div className="mt-0.5 font-mono text-sm font-semibold">{model.bias}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">
            Scor {model.score >= 0 ? "+" : ""}{model.score.toFixed(1)} · 1h {htf.structure_trend} · 15m {confirm.structure_trend} · 5m {exec.structure_trend}
          </div>
        </div>
        <InfoCard
          title={`Traiectorie Kronos ${kronosInterval}`}
          value={model.kChange == null ? "indisponibilă" : `${signed(model.kChange, symbol)} pt`}
          sub={
            model.kEnd == null
              ? "ICT-ul rămâne valabil și fără Kronos"
              : `Final ${fmt(model.kEnd, symbol)} · range proiectat ${fmt(model.projectedRange, symbol)} pt${model.kFirst ? ` · primul nivel: ${model.kFirst}` : ""}`
          }
        />
        <InfoCard
          title={tech ? "Volatilitate US100" : "Volatilitate"}
          value={`ATR5 ${fmt(exec.atr, symbol)} · ATR15 ${fmt(confirm.atr, symbol)}`}
          sub={`ATR1h ${fmt(htf.atr, symbol)} pt · stop sub ~1×ATR(5m) = zgomot${tech ? " · beta tech/AI mare" : ""}`}
        />
        <InfoCard
          title="Locație în Dealing Range"
          value={`${confirm.dealing_range.zone} ${confirm.dealing_range.position_pct}%`}
          sub={`EQ 50% ${fmt(confirm.dealing_range.equilibrium, symbol)} · range ${fmt(confirm.dealing_range.range_low, symbol)}–${fmt(confirm.dealing_range.range_high, symbol)}`}
        />
        <InfoCard
          title="Timing ICT"
          value={confirm.killzone.active ? confirm.killzone.label : "În afara Killzone"}
          sub={`${confirm.killzone.ro_now} RO · ${confirm.killzone.ny_now} NY${confirm.killzone.silver_bullet ? ` · ${confirm.killzone.silver_bullet}` : ""}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="rounded border border-zinc-800 bg-black/40 p-3">
          <h4 className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-300">
            <Waves className="h-4 w-4 text-sky-400" /> Secvența ICT probabilă
          </h4>
          <ol className="space-y-2 text-sm leading-relaxed text-zinc-300">
            <li>
              <strong className="text-zinc-100">1. Raid de lichiditate:</strong>{" "}
              {model.latestSweep
                ? <>ultimul sweep confirmat: <Level>{model.latestSweep.label} {fmt(model.latestSweep.price, symbol)}</Level> la {model.latestSweep.ro_time.slice(11)} RO (wick {fmt(model.latestSweep.wick, symbol)}). </>
                : "încă nu există un sweep proaspăt confirmat. "}
              Magneții rămași: BSL <Level>{fmt(model.nearestBsl?.price, symbol)}</Level>
              {model.eqh ? <> (EQH <Level>{fmt(model.eqh.price, symbol)}</Level>)</> : null}
              {" "}și SSL <Level>{fmt(model.nearestSsl?.price, symbol)}</Level>
              {model.eql ? <> (EQL <Level>{fmt(model.eql.price, symbol)}</Level>)</> : null}.
            </li>
            <li>
              <strong className="text-zinc-100">2. Revenire în dezechilibru:</strong>{" "}
              {model.postBreak ? (
                <>
                  FVG-ul după <Level>{model.postBreak.event.type.replace("_", " ")}</Level> pe {model.postBreak.tf}:
                  <Level> {fmt(model.postBreak.fvg.bottom, symbol)}–{fmt(model.postBreak.fvg.top, symbol)}</Level>,
                  CE <Level>{fmt(model.postBreak.fvg.ce, symbol)}</Level> ({model.postBreak.fvg.status}, umplut {model.postBreak.fvg.fill_pct}%).
                </>
              ) : model.bullFvgBelow || model.bearFvgAbove ? (
                <>nu am un FVG lipit de ultimul BOS/CHoCH; folosesc cel mai apropiat FVG activ de dedesubt/deasupra.</>
              ) : (
                <>nu există FVG activ apropiat — scenariul ICT nu are zonă de intrare.</>
              )}
            </li>
            <li>
              <strong className="text-zinc-100">3. Continuare sau respingere:</strong>{" "}
              {model.aligned
                ? "structurile 5m/15m/1h sunt aliniate, deci retestul FVG are context de continuare."
                : "timeframe-urile nu sunt aliniate (ex. bounce 5m/15m într-un 1h contrar) — tratez mișcarea ca rebound până la primul SIBI/BSL, nu ca trend nou."}
              {model.kFirst ? <> Kronos proiectează primul contact cu <Level>{model.kFirst}</Level>.</> : null}
            </li>
          </ol>
          <p className="mt-3 border-t border-zinc-800 pt-2 text-[11px] leading-relaxed text-zinc-500">
            Scor ICT: {model.reasons.join(" · ")}. Kronos cântărește puțin (±0,5) — dacă Kronos și ICT se contrazic,
            zona FVG/lichiditatea decide intrarea, nu linia forecast-ului.
          </p>
        </div>

        <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3">
          <h4 className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-200">
            <Landmark className="h-4 w-4" /> Context macro 2026 — filtru, nu semnal
          </h4>
          <ul className="space-y-2 text-xs leading-relaxed text-zinc-300">
            <li>
              <strong>Fed restrictivă (ipoteza ta de lucru: 3,75–4,00%, majorări reluate pe inflație):</strong>{" "}
              cost al capitalului mare = presiune pe multiplii tech și sweep-uri mai ample. Nu cumpăra agresiv
              mijlocul range-ului înainte de date SUA / discursuri Fed.
            </li>
            <li>
              <strong>Capex AI:</strong> ghidajele de cheltuieli pentru infrastructură AI (hyperscaleri + NVDA & lanțul de semiconductori)
              pot crea displacement și FVG-uri mari pe US100. După știre așteaptă FVG-ul format după BOS/CHoCH,
              nu anticipa în mijlocul spike-ului.
            </li>
            <li>
              <strong>Execuție:</strong> ferestrele cu probabilitate mai bună rămân Killzone-urile NY; la 15:30 RO (date)
              și 16:30 RO (cash open) volatilitatea US100 poate mătura ambele părți înainte de direcție.
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-zinc-500">
            Ipotezele macro de mai sus sunt contextul introdus de tine pentru 2026 — verifică-le în tab-ul Știri
            și în calendar înainte de orice ordin.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-zinc-950 text-[10px] uppercase tracking-wider text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2">Scenariu ICT</th>
              <th className="px-3 py-2">Intrare / trigger</th>
              <th className="px-3 py-2">Stop / invalidare</th>
              <th className="px-3 py-2">Ținte (lichiditate)</th>
              <th className="px-3 py-2">R:R</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 font-mono">
            <tr className={model.bias === "BULLISH" || !model.aligned ? "hover:bg-zinc-900/60" : "opacity-70"}>
              <td className="px-3 py-2 font-sans font-medium text-emerald-300">
                Long — retest BISI după structură
              </td>
              <td className="px-3 py-2">
                {model.bullFvgBelow ? (
                  <>CE {fmt(model.longEntry, symbol)} · zonă {fmt(model.bullFvgBelow.bottom, symbol)}–{fmt(model.bullFvgBelow.top, symbol)}</>
                ) : "—"}
              </td>
              <td className="px-3 py-2">{fmt(model.longStop, symbol)}</td>
              <td className="px-3 py-2">
                {fmt(model.longT1, symbol)} → {fmt(model.longT2, symbol)}
              </td>
              <td className="px-3 py-2">
                {model.longRr1 ? `${model.longRr1.toFixed(1)}R` : "—"}
                {model.longRr2 ? ` / ${model.longRr2.toFixed(1)}R` : ""}
              </td>
            </tr>
            <tr className={model.bias === "BEARISH" ? "hover:bg-zinc-900/60" : "opacity-70"}>
              <td className="px-3 py-2 font-sans font-medium text-red-300">
                Short — retest SIBI / respingere în Premium
              </td>
              <td className="px-3 py-2">
                {model.bearFvgAbove ? (
                  <>CE {fmt(model.shortEntry, symbol)} · zonă {fmt(model.bearFvgAbove.bottom, symbol)}–{fmt(model.bearFvgAbove.top, symbol)}</>
                ) : "doar după BSL sweep + închidere 5m sub nivelul măturat"}
              </td>
              <td className="px-3 py-2">{model.bearFvgAbove ? fmt(model.shortStop, symbol) : "peste wick-ul sweep-ului (se fixează la confirmare)"}</td>
              <td className="px-3 py-2">
                {fmt(model.shortT1, symbol)} → {fmt(model.shortT2, symbol)}
              </td>
              <td className="px-3 py-2">
                {model.shortRr1 ? `${model.shortRr1.toFixed(1)}R` : "—"}
                {model.shortRr2 ? ` / ${model.shortRr2.toFixed(1)}R` : ""}
              </td>
            </tr>
            <tr>
              <td className="px-3 py-2 font-sans font-medium text-zinc-300">
                Sweep EQH/EQL (Judas) — confirmare
              </td>
              <td className="px-3 py-2 font-sans text-[11px] leading-relaxed">
                Wick peste EQH {fmt(model.eqh?.price, symbol)} / sub EQL {fmt(model.eql?.price, symbol)}, apoi închidere 5m înapoi în range
              </td>
              <td className="px-3 py-2 font-sans text-[11px]">Peste/sub extremul sweep-ului</td>
              <td className="px-3 py-2">
                {fmt(model.bullFvgBelow?.ce ?? model.nearestSsl?.price, symbol)} / {fmt(model.bearFvgAbove?.ce ?? model.nearestBsl?.price, symbol)}
              </td>
              <td className="px-3 py-2 font-sans text-[11px]">după confirmare</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="flex gap-2 text-[11px] leading-relaxed text-amber-200/80">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Invalidare practică: închidere 15m dincolo de marginea FVG-ului folosit la intrare (nu doar wick).
          Pe US100, în jurul datelor și al deschiderii cash, sweep-ul poate depăși nivelul cu 0,5–1×ATR(5m);
          de aceea intrarea se face pe retest/confirmare, iar stopul se pune dincolo de dezechilibru, nu pe linie.
        </span>
      </p>
    </section>
  );
}

function InfoCard({ title, value, sub }: { title: string; value: string; sub: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-zinc-200">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{title}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold">{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-zinc-400">{sub}</div>
    </div>
  );
}

function Level({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-amber-300">{children}</span>;
}
