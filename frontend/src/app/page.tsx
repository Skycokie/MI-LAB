"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Bookmark,
  Landmark,
  Layers,
  RefreshCw,
  Grid3x3,
  Radar,
  Radio,
  Sparkles,
} from "lucide-react";
import GexChart from "@/components/GexChart";
import CotTracker, { COT_CURRENCIES } from "@/components/CotTracker";
import VolumeProfileChart from "@/components/VolumeProfileChart";
import FootprintAlphaChart from "@/components/FootprintAlphaChart";
import WatchlistBoard from "@/components/WatchlistBoard";
import SignalsBoard from "@/components/SignalsBoard";
import ScannerBoard from "@/components/ScannerBoard";
import AlertsBoard from "@/components/AlertsBoard";
import ForecastBoard from "@/components/ForecastBoard";
import { DEFAULT_CFD_WATCHLIST } from "@/lib/watchlist";
import { LabProvider, useLab, type LabTab } from "@/context/LabContext";

const TABS: { id: LabTab; label: string; hint: string; icon: typeof Activity }[] =
  [
    {
      id: "watch",
      label: "Watchlist",
      hint: "CFD daily tracking · price · Δ · absorption",
      icon: Bookmark,
    },
    {
      id: "signals",
      label: "Signals",
      hint: "Absorption feed across your watchlist",
      icon: Radio,
    },
    {
      id: "scanner",
      label: "Scanner",
      hint: "US momentum · gap + RVOL · Yahoo delayed ~15m",
      icon: Radar,
    },
    {
      id: "alerts",
      label: "Alerte",
      hint: "Watchlist rules · breakout / RVOL / RSI · Alpaca risk",
      icon: Bell,
    },
    {
      id: "gex",
      label: "US Equities & ETFs - GEX",
      hint: "Gamma Exposure · Stocks & ETFs",
      icon: BarChart3,
    },
    {
      id: "cot",
      label: "Forex - Institutional COT",
      hint: "Smart Money vs Retail",
      icon: Landmark,
    },
    {
      id: "vp",
      label: "Volume Profile Engine",
      hint: "POC / VAH / VAL + Absorption",
      icon: Layers,
    },
    {
      id: "fp",
      label: "Footprint / Order Flow",
      hint: "Estimated Bid/Ask Imbalances",
      icon: Grid3x3,
    },
    {
      id: "forecast",
      label: "Forecast",
      hint: "Kronos-mini OHLCV prediction · experimental",
      icon: Sparkles,
    },
  ];

const ETF_PRESETS = [
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "GLD",
  "SLV",
  "TLT",
  "HYG",
  "XLF",
  "XLE",
  "SMH",
  "ARKK",
];
const STOCK_PRESETS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "META"];
const CFD_PRESETS = DEFAULT_CFD_WATCHLIST.map((i) => ({
  label: i.symbol,
  value: i.symbol,
}));
const FLOW_PRESETS = [
  { label: "ES", value: "ES=F" },
  { label: "NQ", value: "NQ=F" },
  { label: "SPY", value: "SPY" },
  { label: "QQQ", value: "QQQ" },
  { label: "IWM", value: "IWM" },
  { label: "GLD", value: "GLD" },
  { label: "TLT", value: "TLT" },
  ...CFD_PRESETS,
  { label: "EUR", value: "EUR" },
  { label: "GBP", value: "GBP" },
  { label: "JPY", value: "JPY" },
];

export default function Home() {
  return (
    <LabProvider>
      <LabShell />
    </LabProvider>
  );
}

function LabShell() {
  const {
    activeSymbol,
    setActiveSymbol,
    tab,
    setTab,
    refreshKey,
    bumpRefresh,
  } = useLab();
  const [cotCurrency, setCotCurrency] = useState<string>("EUR");
  /** Local draft while typing; null means show activeSymbol from context. */
  const [draft, setDraft] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);

  const showTickerBar =
    tab === "gex" || tab === "vp" || tab === "fp" || tab === "forecast";
  const showFlowPresets = tab === "vp" || tab === "fp" || tab === "forecast";
  const inputValue = draft ?? (showTickerBar ? activeSymbol : "");

  const active = useMemo(() => TABS.find((t) => t.id === tab)!, [tab]);

  function selectTab(next: LabTab) {
    setDraft(null);
    setTab(next);
  }

  function applyTicker(value: string) {
    const next = value.trim().toUpperCase();
    if (!next) return;
    setDraft(null);
    setActiveSymbol(next);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    applyTicker(inputValue);
  }

  function refresh() {
    bumpRefresh();
    setLastRefresh(new Date().toLocaleTimeString("en-GB"));
    setSpinning(true);
    window.setTimeout(() => setSpinning(false), 800);
  }

  return (
    <div className="flex min-h-screen flex-col bg-black text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="rounded-sm bg-amber-500 px-1.5 py-0.5 font-mono text-xs font-bold text-black">
              MIL
            </span>
            <span className="text-sm font-semibold tracking-wide text-zinc-100">
              Market Institutional Lab
            </span>
          </div>

          <div className="flex flex-1 flex-wrap items-center gap-2">
            {tab === "cot" ? (
              <>
                <label className="text-[11px] uppercase tracking-wider text-zinc-500">
                  Currency
                </label>
                <select
                  value={cotCurrency}
                  onChange={(e) => setCotCurrency(e.target.value)}
                  className="rounded border border-zinc-700 bg-black px-3 py-1.5 font-mono text-sm text-amber-400 outline-none focus:border-amber-500"
                >
                  {COT_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </>
            ) : showTickerBar ? (
              <form onSubmit={onSubmit} className="flex items-center gap-2">
                <label className="text-[11px] uppercase tracking-wider text-zinc-500">
                  Ticker
                </label>
                <input
                  value={inputValue}
                  onChange={(e) => setDraft(e.target.value.toUpperCase())}
                  placeholder={
                    tab === "gex" ? "SPY, QQQ, NVDA.US" : "ES=F, SPY, TER.US"
                  }
                  spellCheck={false}
                  className="w-40 rounded border border-zinc-700 bg-black px-3 py-1.5 font-mono text-sm text-amber-400 outline-none placeholder:text-zinc-700 focus:border-amber-500"
                />
                <button
                  type="submit"
                  className="rounded border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-amber-500 hover:text-amber-400"
                >
                  Load
                </button>
              </form>
            ) : tab === "scanner" ? (
              <p className="text-xs text-zinc-600">
                Liquid US universe · adjust filters · open GEX / VP / FP from
                hits
              </p>
            ) : (
              <p className="text-xs text-zinc-600">
                Manage symbols below · open GEX / VP / FP from each row
              </p>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {tab === "gex" && (
                <>
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    ETF
                  </span>
                  {ETF_PRESETS.map((p) => (
                    <Preset
                      key={p}
                      active={activeSymbol === p}
                      onClick={() => applyTicker(p)}
                    >
                      {p}
                    </Preset>
                  ))}
                  <span className="mx-1 h-3 w-px bg-zinc-700" aria-hidden />
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    Stock
                  </span>
                  {STOCK_PRESETS.map((p) => (
                    <Preset
                      key={p}
                      active={activeSymbol === p}
                      onClick={() => applyTicker(p)}
                    >
                      {p}
                    </Preset>
                  ))}
                  <span className="mx-1 h-3 w-px bg-zinc-700" aria-hidden />
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    CFD
                  </span>
                  {CFD_PRESETS.map((p) => (
                    <Preset
                      key={p.value}
                      active={activeSymbol === p.value}
                      onClick={() => applyTicker(p.value)}
                    >
                      {p.label}
                    </Preset>
                  ))}
                </>
              )}
              {showFlowPresets && (
                <>
                  <span className="mr-1 text-[10px] uppercase tracking-wider text-zinc-600">
                    Watch
                  </span>
                  {FLOW_PRESETS.map((p) => (
                    <Preset
                      key={p.value}
                      active={activeSymbol === p.value}
                      onClick={() => applyTicker(p.value)}
                    >
                      {p.label}
                    </Preset>
                  ))}
                </>
              )}
              {tab === "cot" &&
                COT_CURRENCIES.map((c) => (
                  <Preset
                    key={c}
                    active={cotCurrency === c}
                    onClick={() => setCotCurrency(c)}
                  >
                    {c}
                  </Preset>
                ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="hidden font-mono text-[11px] text-zinc-500 sm:inline">
                refreshed {lastRefresh}
              </span>
            )}
            <button
              type="button"
              onClick={refresh}
              className="inline-flex items-center gap-2 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-400"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${spinning ? "animate-spin" : ""}`}
              />
              Refresh Data
            </button>
          </div>
        </div>

        <nav
          className="mx-auto flex w-full max-w-[1500px] gap-1 overflow-x-auto px-4 sm:px-6"
          role="tablist"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = t.id === tab;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={isActive}
                type="button"
                onClick={() => selectTab(t.id)}
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  isActive
                    ? "border-amber-500 text-amber-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-200"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6">
        <p className="mb-4 text-[11px] uppercase tracking-[0.2em] text-zinc-600">
          {active.hint}
        </p>

        {tab === "watch" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <WatchlistBoard />
          </section>
        )}

        {tab === "signals" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <SignalsBoard />
          </section>
        )}

        {tab === "scanner" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <ScannerBoard />
          </section>
        )}

        {tab === "alerts" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <AlertsBoard />
          </section>
        )}

        {tab === "gex" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <GexChart />
          </section>
        )}

        {tab === "cot" && (
          <CotTracker
            currency={cotCurrency}
            onCurrencyChange={setCotCurrency}
            refreshKey={refreshKey}
          />
        )}

        {tab === "vp" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <VolumeProfileChart />
          </section>
        )}

        {tab === "fp" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <FootprintAlphaChart />
          </section>
        )}

        {tab === "forecast" && (
          <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 sm:p-5">
            <ForecastBoard />
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-900 px-4 py-3 text-center text-[11px] text-zinc-600">
        Watchlist saved in browser localStorage · Yahoo quotes & estimated
        absorption · Educational use only.
      </footer>
    </div>
  );
}

function Preset({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 font-mono text-[11px] transition ${
        active
          ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40"
          : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}
