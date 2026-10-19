/** Default CFD watchlist + localStorage persistence. */

export type WatchItem = {
  symbol: string;
  label?: string;
  addedAt: string;
};

export const DEFAULT_CFD_WATCHLIST: WatchItem[] = [
  { symbol: "NVDA.US", addedAt: "default" },
  { symbol: "PTC.US", addedAt: "default" },
  { symbol: "ADSK.US", addedAt: "default" },
  { symbol: "TSLA.US", addedAt: "default" },
  { symbol: "TER.US", addedAt: "default" },
  { symbol: "PH.US", addedAt: "default" },
  { symbol: "EMR.US", addedAt: "default" },
  { symbol: "ROK.US", addedAt: "default" },
  { symbol: "RRX.US", addedAt: "default" },
  { symbol: "MOGA.U", addedAt: "default" },
  { symbol: "SIE.DE", addedAt: "default" },
  { symbol: "DSY.FR", addedAt: "default" },
];

const STORAGE_KEY = "mil.watchlist.v1";

export function loadWatchlist(): WatchItem[] {
  if (typeof window === "undefined") return [...DEFAULT_CFD_WATCHLIST];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_CFD_WATCHLIST];
    const parsed = JSON.parse(raw) as WatchItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...DEFAULT_CFD_WATCHLIST];
    }
    return parsed
      .filter((x) => x && typeof x.symbol === "string" && x.symbol.trim())
      .map((x) => ({
        symbol: x.symbol.trim().toUpperCase(),
        label: x.label,
        addedAt: x.addedAt || new Date().toISOString(),
      }));
  } catch {
    return [...DEFAULT_CFD_WATCHLIST];
  }
}

export function saveWatchlist(items: WatchItem[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export function addToWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  const u = symbol.trim().toUpperCase();
  if (!u) return items;
  if (items.some((i) => i.symbol === u)) return items;
  const next = [
    ...items,
    { symbol: u, addedAt: new Date().toISOString() },
  ];
  saveWatchlist(next);
  return next;
}

export function removeFromWatchlist(
  items: WatchItem[],
  symbol: string,
): WatchItem[] {
  const u = symbol.trim().toUpperCase();
  const next = items.filter((i) => i.symbol !== u);
  saveWatchlist(next);
  return next;
}

export function resetWatchlist(): WatchItem[] {
  const next = [...DEFAULT_CFD_WATCHLIST];
  saveWatchlist(next);
  return next;
}

export function watchlistSymbols(items: WatchItem[]): string[] {
  return items.map((i) => i.symbol);
}
