/** Default CFD watchlist + localStorage persistence. */

export type WatchItem = {
  symbol: string;
  label?: string;
  addedAt: string;
};

export const DEFAULT_CFD_WATCHLIST: WatchItem[] = [
  // AI / semis / memory (correlated — max 2 positions at a time)
  { symbol: "NVDA.US", label: "Nvidia", addedAt: "default" },
  { symbol: "MU", label: "Micron", addedAt: "default" },
  { symbol: "SNDK", label: "Sandisk", addedAt: "default" },
  { symbol: "INTC", label: "Intel", addedAt: "default" },
  // AI infra / bitcoin miner
  { symbol: "CRWV", label: "CoreWeave", addedAt: "default" },
  { symbol: "HUT", label: "Hut 8", addedAt: "default" },
  // High-momentum / speculative
  { symbol: "SPCX", label: "SpaceX (SPCX)", addedAt: "default" },
  { symbol: "RKLB", label: "Rocket Lab", addedAt: "default" },
  { symbol: "TSLA.US", label: "Tesla", addedAt: "default" },
  // Diversifiers (fintech / software / Brazil)
  { symbol: "SOFI", label: "SoFi Technologies", addedAt: "default" },
  { symbol: "ADSK.US", label: "Autodesk", addedAt: "default" },
  { symbol: "XP", label: "XP Inc", addedAt: "default" },
];

/**
 * Removed on 8 Nov 2026 (too many correlated names): INLF, INO, CLRO, EVGO,
 * LITE, MRVL, WULF, CIFR, GRAB, PLUG, QUBT, CRML, NNE, INOD, SPCE, NU, EWZ,
 * SOXL, PTC.US, TER.US, PH.US, EMR.US, ROK.US, RRX.US, MOGA.U, SIE.DE, DSY.FR.
 * Re-add any of them from the search box.
 */

/** Bumped so Chrome localStorage picks up the trimmed 12-symbol set. */
const STORAGE_KEY = "mil.watchlist.v6";
const CRYPTO_STORAGE_KEY = "mil.crypto.watchlist.v4";
const INDICES_STORAGE_KEY = "mil.indices.watchlist.v3";
const FOREX_STORAGE_KEY = "mil.forex.watchlist.v3";

/** Forex pairs — quotes via Yahoo spot; VP / FP volume from CME 6x futures. */
export const DEFAULT_FOREX_WATCHLIST: WatchItem[] = [
  { symbol: "EURUSD", label: "Euro / Dollar", addedAt: "default" },
  { symbol: "GBPUSD", label: "Pound / Dollar", addedAt: "default" },
  { symbol: "USDJPY", label: "Dollar / Yen", addedAt: "default" },
  { symbol: "GBPJPY", label: "Pound / Yen", addedAt: "default" },
  { symbol: "AUDUSD", label: "Aussie / Dollar", addedAt: "default" },
  { symbol: "XAUUSD", label: "Gold (GC futures)", addedAt: "default" },
];

/** Broker-style crypto CFDs (BTC.US) — quotes via Yahoo, bars via HTX. */
export const DEFAULT_CRYPTO_WATCHLIST: WatchItem[] = [
  { symbol: "BTC.US", addedAt: "default" },
  { symbol: "ETH.US", addedAt: "default" },
  { symbol: "SOL.US", addedAt: "default" },
  { symbol: "XRP.US", addedAt: "default" },
];

/** Index CFDs (Trading212-style) → Yahoo futures / cash indices. */
export const DEFAULT_INDICES_WATCHLIST: WatchItem[] = [
  { symbol: "US100", label: "Nasdaq 100", addedAt: "default" },
  { symbol: "USA500", label: "S&P 500", addedAt: "default" },
  { symbol: "GER40", label: "DAX 40", addedAt: "default" },
  { symbol: "UK100", label: "FTSE 100", addedAt: "default" },
];

function parseStored(raw: string | null, defaults: WatchItem[]): WatchItem[] {
  if (!raw) return [...defaults];
  const parsed = JSON.parse(raw) as WatchItem[];
  if (!Array.isArray(parsed) || parsed.length === 0) return [...defaults];
  const items = parsed
    .filter((x) => x && typeof x.symbol === "string" && x.symbol.trim())
    .map((x) => ({
      symbol: x.symbol.trim().toUpperCase(),
      label: x.label,
      addedAt: x.addedAt || new Date().toISOString(),
    }));
  return items.length ? items : [...defaults];
}

export function loadNamedWatchlist(
  key: string,
  defaults: WatchItem[],
): WatchItem[] {
  if (typeof window === "undefined") return [...defaults];
  try {
    return parseStored(localStorage.getItem(key), defaults);
  } catch {
    return [...defaults];
  }
}

export function saveNamedWatchlist(key: string, items: WatchItem[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(items));
}

export function addToNamedWatchlist(
  key: string,
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  const u = symbol.trim().toUpperCase();
  if (!u) return items;
  if (items.some((i) => i.symbol === u)) return items;
  const next = [...items, { symbol: u, addedAt: new Date().toISOString() }];
  saveNamedWatchlist(key, next);
  return next;
}

export function removeFromNamedWatchlist(
  key: string,
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  const u = symbol.trim().toUpperCase();
  const next = items.filter((i) => i.symbol !== u);
  saveNamedWatchlist(key, next);
  return next;
}

export function resetNamedWatchlist(
  key: string,
  defaults: WatchItem[],
): WatchItem[] {
  const next = [...defaults];
  saveNamedWatchlist(key, next);
  return next;
}

export function loadWatchlist(): WatchItem[] {
  return loadNamedWatchlist(STORAGE_KEY, DEFAULT_CFD_WATCHLIST);
}

export function saveWatchlist(items: WatchItem[]): void {
  saveNamedWatchlist(STORAGE_KEY, items);
}

export function addToWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return addToNamedWatchlist(STORAGE_KEY, items, symbol);
}

export function removeFromWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return removeFromNamedWatchlist(STORAGE_KEY, items, symbol);
}

export function resetWatchlist(): WatchItem[] {
  return resetNamedWatchlist(STORAGE_KEY, DEFAULT_CFD_WATCHLIST);
}

export function loadCryptoWatchlist(): WatchItem[] {
  return loadNamedWatchlist(CRYPTO_STORAGE_KEY, DEFAULT_CRYPTO_WATCHLIST);
}

export function addToCryptoWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return addToNamedWatchlist(CRYPTO_STORAGE_KEY, items, symbol);
}

export function removeFromCryptoWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return removeFromNamedWatchlist(CRYPTO_STORAGE_KEY, items, symbol);
}

export function resetCryptoWatchlist(): WatchItem[] {
  return resetNamedWatchlist(CRYPTO_STORAGE_KEY, DEFAULT_CRYPTO_WATCHLIST);
}

export function loadIndicesWatchlist(): WatchItem[] {
  return loadNamedWatchlist(INDICES_STORAGE_KEY, DEFAULT_INDICES_WATCHLIST);
}

export function addToIndicesWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return addToNamedWatchlist(INDICES_STORAGE_KEY, items, symbol);
}

export function removeFromIndicesWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return removeFromNamedWatchlist(INDICES_STORAGE_KEY, items, symbol);
}

export function resetIndicesWatchlist(): WatchItem[] {
  return resetNamedWatchlist(INDICES_STORAGE_KEY, DEFAULT_INDICES_WATCHLIST);
}

export function loadForexWatchlist(): WatchItem[] {
  return loadNamedWatchlist(FOREX_STORAGE_KEY, DEFAULT_FOREX_WATCHLIST);
}

export function addToForexWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return addToNamedWatchlist(FOREX_STORAGE_KEY, items, symbol);
}

export function removeFromForexWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  return removeFromNamedWatchlist(FOREX_STORAGE_KEY, items, symbol);
}

export function resetForexWatchlist(): WatchItem[] {
  return resetNamedWatchlist(FOREX_STORAGE_KEY, DEFAULT_FOREX_WATCHLIST);
}

export function watchlistSymbols(items: WatchItem[]): string[] {
  return items.map((i) => i.symbol);
}
