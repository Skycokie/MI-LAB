/** Price formatting helpers (FX needs pip-level precision). */

const FX_CCY = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
  "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "MXN", "ZAR",
  "TRY", "SGD", "HKD", "CNH", "CNY",
]);

/** EURUSD / EUR/USD / EURUSD=X → true. */
export function isFxSymbol(symbol: string | undefined | null): boolean {
  if (!symbol) return false;
  const raw = symbol.toUpperCase().replace(/=X|[\/\-_ ]/g, "");
  return (
    raw.length === 6 &&
    FX_CCY.has(raw.slice(0, 3)) &&
    FX_CCY.has(raw.slice(3)) &&
    raw.slice(0, 3) !== raw.slice(3)
  );
}

/** Decimals for a price: FX pairs 5 (3 for JPY-scale), others by magnitude. */
export function priceDecimals(price: number, symbol?: string | null): number {
  if (isFxSymbol(symbol)) return price >= 20 ? 3 : 5;
  return price < 20 ? 4 : 2;
}

export function fmtPriceFor(price: number, symbol?: string | null): string {
  if (isFxSymbol(symbol)) return price.toFixed(priceDecimals(price, symbol));
  if (price >= 50) return price.toFixed(2);
  return price.toFixed(4);
}

/** Smallest chart increment for the given price. */
export function priceMinMove(price: number, symbol?: string | null): number {
  return Math.pow(10, -priceDecimals(price, symbol));
}
