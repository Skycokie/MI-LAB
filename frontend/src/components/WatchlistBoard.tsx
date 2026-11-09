"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BarChart3,
  Grid3x3,
  Layers,
  Newspaper,
  Plus,
  Sparkles,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import {
  fetchJson,
  postJson,
  putJson,
  scanSignalsChunked,
  type QuotesResponse,
  type QuoteRow,
  type SearchResponse,
  type SearchResult,
  type WatchlistSignalsResponse,
} from "@/lib/api";
import {
  addToCryptoWatchlist,
  addToForexWatchlist,
  addToIndicesWatchlist,
  addToWatchlist,
  DEFAULT_CFD_WATCHLIST,
  DEFAULT_CRYPTO_WATCHLIST,
  DEFAULT_FOREX_WATCHLIST,
  DEFAULT_INDICES_WATCHLIST,
  loadCryptoWatchlist,
  loadForexWatchlist,
  loadIndicesWatchlist,
  loadWatchlist,
  removeFromCryptoWatchlist,
  removeFromForexWatchlist,
  removeFromIndicesWatchlist,
  removeFromWatchlist,
  resetCryptoWatchlist,
  resetForexWatchlist,
  resetIndicesWatchlist,
  resetWatchlist,
  watchlistSymbols,
  type WatchItem,
} from "@/lib/watchlist";
import { getTradingProgram } from "@/lib/tradingPrograms";
import { fmtPriceFor } from "@/lib/format";
import { useLab, type OpenTarget } from "@/context/LabContext";

export type { OpenTarget };

export type WatchlistVariant = "cfd" | "crypto" | "indices" | "forex";

const VARIANT = {
  cfd: {
    title: "CFD Watchlist",
    subtitle: (n: number) =>
      `Saved in this browser · ${n} symbols · program + price + Δ + absorption`,
    placeholder: "Search e.g. siemens, NVDA…",
    resetTitle: "Restore default CFD list",
    defaults: DEFAULT_CFD_WATCHLIST,
    load: loadWatchlist,
    add: addToWatchlist,
    remove: removeFromWatchlist,
    reset: resetWatchlist,
    syncAlerts: true,
    showGex: true,
    showForecast: false,
  },
  crypto: {
    title: "Crypto Watchlist",
    subtitle: (n: number) =>
      `Crypto CFDs (BTC.US) · HTX + Yahoo · ${n} pairs · price + day Δ`,
    placeholder: "Search e.g. BTC.US, ETH, PEPE…",
    resetTitle: "Restore default crypto list",
    defaults: DEFAULT_CRYPTO_WATCHLIST,
    load: loadCryptoWatchlist,
    add: addToCryptoWatchlist,
    remove: removeFromCryptoWatchlist,
    reset: resetCryptoWatchlist,
    syncAlerts: false,
    showGex: false,
    showForecast: true,
  },
  indices: {
    title: "Indices CFD",
    subtitle: (n: number) =>
      `Index CFDs · USA500 US100 GER40 · Yahoo futures · ${n} symbols`,
    placeholder: "Search e.g. USA500, GER40, GOLD…",
    resetTitle: "Restore default indices list",
    defaults: DEFAULT_INDICES_WATCHLIST,
    load: loadIndicesWatchlist,
    add: addToIndicesWatchlist,
    remove: removeFromIndicesWatchlist,
    reset: resetIndicesWatchlist,
    syncAlerts: false,
    showGex: false,
    showForecast: true,
  },
  forex: {
    title: "Forex Watchlist",
    subtitle: (n: number) =>
      `Forex pairs · spot price (Yahoo) · VP / FP volume from CME futures · ${n} pairs`,
    placeholder: "Search e.g. EURUSD, GBPJPY, NZDUSD…",
    resetTitle: "Restore default forex list",
    defaults: DEFAULT_FOREX_WATCHLIST,
    load: loadForexWatchlist,
    add: addToForexWatchlist,
    remove: removeFromForexWatchlist,
    reset: resetForexWatchlist,
    syncAlerts: false,
    showGex: false,
    showForecast: true,
  },
} as const;

function syncAlertsWatchlist(items: WatchItem[]) {
  void putJson("/api/alerts/watchlist", {
    symbols: items.map((i) => ({ symbol: i.symbol, label: i.label })),
  }).catch(() => {
    /* server may be down locally — ignore */
  });
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export default function WatchlistBoard({
  variant = "cfd",
}: {
  variant?: WatchlistVariant;
}) {
  const cfg = VARIANT[variant];
  const { refreshKey, openSymbol } = useLab();
  const [items, setItems] = useState<WatchItem[]>([...cfg.defaults]);
  const [addInput, setAddInput] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [quoteErrors, setQuoteErrors] = useState<QuotesResponse["errors"]>([]);
  const [latestBySymbol, setLatestBySymbol] = useState<
    Record<string, WatchlistSignalsResponse["per_symbol"][0] | undefined>
  >({});
  const [scanErrors, setScanErrors] = useState<
    WatchlistSignalsResponse["errors"]
  >([]);
  const [quotesFor, setQuotesFor] = useState<string | null>(null);
  const [signalsFor, setSignalsFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const symbols = useMemo(() => watchlistSymbols(items), [items]);
  const symbolsKey = symbols.join(",");
  const quotesRequestKey = `${symbolsKey}|${refreshKey}`;
  const signalsRequestKey = `${symbolsKey}|${refreshKey}`;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      const loaded = cfg.load();
      setItems(loaded);
      if (cfg.syncAlerts) syncAlertsWatchlist(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [cfg]);

  useEffect(() => {
    let cancelled = false;

    if (symbols.length === 0) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setQuotes([]);
        setQuoteErrors([]);
        setQuotesFor(quotesRequestKey);
      });
      return () => {
        cancelled = true;
      };
    }

    postJson<QuotesResponse>("/api/watchlist/quotes", { symbols })
      .then((res) => {
        if (cancelled) return;
        setQuotes(res.quotes);
        setQuoteErrors(res.errors);
        setError(null);
        setQuotesFor(quotesRequestKey);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setQuotesFor(quotesRequestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [symbols, symbolsKey, quotesRequestKey]);

  useEffect(() => {
    let cancelled = false;

    if (symbols.length === 0) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setLatestBySymbol({});
        setScanErrors([]);
        setSignalsFor(signalsRequestKey);
      });
      return () => {
        cancelled = true;
      };
    }

    const apply = (res: WatchlistSignalsResponse) => {
      const map: typeof latestBySymbol = {};
      for (const row of res.per_symbol) map[row.symbol] = row;
      setLatestBySymbol(map);
      setScanErrors(res.errors);
    };

    scanSignalsChunked(
      symbols,
      { interval: "15m", limit_per: 3, refresh: refreshKey > 0 },
      (partial) => {
        if (cancelled) return;
        apply(partial);
      },
    )
      .then((res) => {
        if (cancelled) return;
        apply(res);
        setSignalsFor(signalsRequestKey);
      })
      .catch(() => {
        if (cancelled) return;
        setSignalsFor(signalsRequestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [symbols, symbolsKey, signalsRequestKey, refreshKey]);

  useEffect(() => {
    const q = addInput.trim();
    if (q.length < 2) return;

    const seq = ++searchSeq.current;
    const timer = window.setTimeout(() => {
      fetchJson<SearchResponse>(
        `/api/watchlist/search?q=${encodeURIComponent(q)}&limit=8`,
      )
        .then((res) => {
          if (seq !== searchSeq.current) return;
          setSearchResults(res.results);
          setHighlight(0);
          setSearchOpen(true);
          setSearchLoading(false);
          setSearchError(null);
        })
        .catch((err: Error) => {
          if (seq !== searchSeq.current) return;
          setSearchResults([]);
          setSearchError(err.message);
          setSearchLoading(false);
          setSearchOpen(true);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [addInput]);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!searchWrapRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setSearchOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const loadingQuotes = quotesFor !== quotesRequestKey;
  const loadingSignals = signalsFor !== signalsRequestKey;
  const inList = useMemo(
    () => new Set(items.map((i) => i.symbol)),
    [items],
  );

  function pickSymbol(symbol: string) {
    const next = cfg.add(items, symbol);
    setItems(next);
    if (cfg.syncAlerts) syncAlertsWatchlist(next);
    setAddInput("");
    setSearchResults([]);
    setSearchOpen(false);
    setSearchError(null);
  }

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (searchOpen && searchResults.length > 0) {
      const pick =
        searchResults[Math.min(highlight, searchResults.length - 1)];
      pickSymbol(pick.symbol);
      return;
    }
    const typed = addInput.trim().toUpperCase();
    if (!typed) return;
    pickSymbol(typed);
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!searchOpen || searchResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % searchResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + searchResults.length) % searchResults.length);
    }
  }

  function onRemove(symbol: string) {
    const next = cfg.remove(items, symbol);
    setItems(next);
    if (cfg.syncAlerts) syncAlertsWatchlist(next);
  }

  function onReset() {
    const next = cfg.reset();
    setItems(next);
    if (cfg.syncAlerts) syncAlertsWatchlist(next);
  }

  const quoteMap = useMemo(() => {
    const m = new Map<string, QuoteRow>();
    for (const q of quotes) m.set(q.symbol, q);
    return m;
  }, [quotes]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{cfg.title}</h2>
          <p className="text-xs text-zinc-500">{cfg.subtitle(items.length)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={onAdd} className="flex gap-2">
            <div ref={searchWrapRef} className="relative">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                <input
                  value={addInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAddInput(v);
                    setSearchOpen(true);
                    if (v.trim().length < 2) {
                      searchSeq.current += 1;
                      setSearchResults([]);
                      setSearchLoading(false);
                      setSearchError(null);
                    } else {
                      setSearchLoading(true);
                      setSearchError(null);
                    }
                  }}
                  onFocus={() => {
                    if (addInput.trim().length >= 2 || searchResults.length > 0) {
                      setSearchOpen(true);
                    }
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder={cfg.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  role="combobox"
                  aria-expanded={searchOpen}
                  aria-controls="symbol-search-list"
                  className="w-56 rounded border border-zinc-700 bg-black py-1.5 pl-8 pr-3 font-mono text-sm text-amber-400 outline-none placeholder:text-zinc-600 focus:border-amber-500"
                />
              </div>
              {searchOpen && addInput.trim().length >= 2 && (
                <div
                  id="symbol-search-list"
                  role="listbox"
                  className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950 shadow-lg"
                >
                  {searchLoading && (
                    <p className="px-3 py-2 text-xs text-zinc-500">Searching…</p>
                  )}
                  {!searchLoading && searchError && (
                    <p className="px-3 py-2 text-xs text-red-300">{searchError}</p>
                  )}
                  {!searchLoading &&
                    !searchError &&
                    searchResults.length === 0 && (
                      <p className="px-3 py-2 text-xs text-zinc-500">
                        No matches
                      </p>
                    )}
                  {!searchLoading &&
                    searchResults.map((r, idx) => {
                      const already = inList.has(r.symbol);
                      const active = idx === highlight;
                      return (
                        <button
                          key={r.symbol}
                          type="button"
                          role="option"
                          aria-selected={active}
                          disabled={already}
                          onMouseEnter={() => setHighlight(idx)}
                          onClick={() => {
                            if (!already) pickSymbol(r.symbol);
                          }}
                          className={`flex w-full items-start gap-2 px-3 py-2 text-left transition ${
                            already
                              ? "cursor-default opacity-50"
                              : active
                                ? "bg-zinc-900"
                                : "hover:bg-zinc-900/80"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-sm font-semibold text-amber-400">
                              {r.symbol}
                            </div>
                            <div className="truncate text-[11px] text-zinc-500">
                              {r.name}
                              {r.exchange ? ` · ${r.exchange}` : ""}
                              {r.type ? ` · ${r.type}` : ""}
                            </div>
                          </div>
                          {already && (
                            <span className="shrink-0 text-[10px] uppercase tracking-wider text-zinc-600">
                              In list
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-amber-500 hover:text-amber-400"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </form>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 rounded border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300"
            title={cfg.resetTitle}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[11px] uppercase tracking-wider text-zinc-500">
            <tr>
              <th className="px-3 py-2.5 font-medium">Symbol</th>
              <th className="px-3 py-2.5 font-medium">Program</th>
              <th className="px-3 py-2.5 font-medium">Price</th>
              <th className="px-3 py-2.5 font-medium">Δ day</th>
              <th className="px-3 py-2.5 font-medium">Absorption</th>
              <th className="px-3 py-2.5 font-medium">Open</th>
              <th className="px-3 py-2.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const q = quoteMap.get(item.symbol);
              const scan = latestBySymbol[item.symbol];
              const latest = scan?.latest;
              const up = (q?.change_pct ?? 0) >= 0;
              const program = getTradingProgram(item.symbol);
              return (
                <tr
                  key={item.symbol}
                  className="border-b border-zinc-900/80 hover:bg-zinc-900/50"
                >
                  <td className="px-3 py-2.5">
                    <div className="font-mono font-semibold text-amber-400">
                      {item.symbol}
                    </div>
                    <div className="text-[10px] text-zinc-600">
                      {item.label
                        ? `${item.label} · `
                        : ""}
                      {q?.yahoo_symbol || "—"}
                      {q?.name ? ` · ${q.name}` : ""}
                    </div>
                  </td>
                  <td className="max-w-[280px] px-3 py-2.5 align-top">
                    <div className="text-[11px] font-medium text-zinc-200">
                      {program.style}
                    </div>
                    <div className="mt-0.5 text-[10px] text-amber-500/80">
                      {program.session}
                    </div>
                    <div className="mt-1 text-[10px] leading-snug text-zinc-500">
                      {program.plan}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-zinc-200">
                    {loadingQuotes && !q ? (
                      <span className="text-zinc-600">…</span>
                    ) : q ? (
                      fmtPriceFor(q.price, item.symbol)
                    ) : (
                      <span className="text-zinc-600">n/a</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono">
                    {q ? (
                      <span className={up ? "text-emerald-400" : "text-red-400"}>
                        {fmtPct(q.change_pct)}{" "}
                        <span className="text-zinc-600">
                          ({up ? "+" : ""}
                          {q.change})
                        </span>
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {loadingSignals && !scan ? (
                      <span className="text-xs text-zinc-600">scanning…</span>
                    ) : latest ? (
                      <AbsBadge type={latest.absorption_type} />
                    ) : (
                      <span className="text-xs text-zinc-600">none</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {cfg.showGex && (
                        <OpenBtn
                          label="GEX"
                          icon={BarChart3}
                          onClick={() => openSymbol(item.symbol, "gex")}
                        />
                      )}
                      <OpenBtn
                        label="VP"
                        icon={Layers}
                        onClick={() => openSymbol(item.symbol, "vp")}
                      />
                      <OpenBtn
                        label="FP"
                        icon={Grid3x3}
                        onClick={() => openSymbol(item.symbol, "fp")}
                      />
                      {cfg.showForecast && (
                        <OpenBtn
                          label="FC"
                          icon={Sparkles}
                          onClick={() => openSymbol(item.symbol, "forecast")}
                        />
                      )}
                      <OpenBtn
                        label="News"
                        icon={Newspaper}
                        onClick={() => openSymbol(item.symbol, "news")}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => onRemove(item.symbol)}
                      className="rounded p-1.5 text-zinc-600 hover:bg-red-500/10 hover:text-red-400"
                      title="Remove"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(quoteErrors.length > 0 || scanErrors.length > 0) && (
        <p className="text-[11px] text-zinc-600">
          Some symbols failed:{" "}
          {[...quoteErrors, ...scanErrors]
            .map((e) => e.symbol)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

function AbsBadge({ type }: { type: string }) {
  const bull = type === "BULLISH_ABSORPTION";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-[11px] font-medium ${
        bull
          ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
          : "bg-red-500/15 text-red-300 ring-1 ring-red-500/30"
      }`}
    >
      {bull ? "Bullish ABS" : "Bearish ABS"}
    </span>
  );
}

function OpenBtn({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof BarChart3;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] font-medium text-zinc-400 hover:border-amber-500/50 hover:text-amber-400"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
