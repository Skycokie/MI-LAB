const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  "http://localhost:8000";

export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Appends `refresh=true` (server cache bypass) once the user hit Refresh. */
export function withRefresh(path: string, refreshKey: number): string {
  if (refreshKey <= 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}refresh=true`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: "no-store" });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json() as Promise<T>;
}

export type GexLevel = {
  strike: number;
  gex_call: number;
  gex_put: number;
  total_gex: number;
};

export type GexUnavailable = {
  available: false;
  reason: "EUROPEAN_NO_US_OPTIONS" | "NO_OPTIONS_CHAIN" | string;
  ticker: string;
  yahoo_symbol: string;
  proxy_note?: string | null;
  message: string;
  suggested_tabs: Array<"vp" | "fp" | string>;
};

export type GexAvailable = {
  available?: true;
  ticker: string;
  yahoo_symbol?: string;
  proxy_note?: string | null;
  spot_price: number;
  expiration: string;
  expirations: string[];
  net_gex: number;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  interest_source?: "open_interest" | "volume_fallback";
  levels: GexLevel[];
};

export type GexResponse = GexUnavailable | GexAvailable;

export function isGexUnavailable(data: GexResponse): data is GexUnavailable {
  return data.available === false;
}

export type CotWeek = {
  report_date: string;
  non_commercials_long: number;
  non_commercials_short: number;
  non_commercials_net: number;
  commercials_long: number;
  commercials_short: number;
  commercials_net: number;
  retail_long: number;
  retail_short: number;
  retail_net: number;
  open_interest: number;
};

export type CotResponse = {
  currency: string;
  market: string;
  market_code: string;
  market_name: string;
  report_date: string;
  weeks: number;
  commercials_net: number;
  non_commercials_net: number;
  retail_net: number;
  weekly_change: {
    commercials_net: number;
    non_commercials_net: number;
    retail_net: number;
  };
  sentiment: string;
  history: CotWeek[];
  source: string;
};

export type VolumeProfileLevel = {
  price: number;
  volume: number;
  is_poc: boolean;
  in_value_area: boolean;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  session: string;
};

export type VwapSignalType =
  | "VWAP_BREAKOUT_UP"
  | "VWAP_BREAKOUT_DOWN"
  | "VWAP_PULLBACK_LONG"
  | "VWAP_PULLBACK_SHORT"
  | string;

export type VwapSignal = {
  time: number;
  price: number;
  type: VwapSignalType;
};

export type VwapPoint = {
  time: number;
  vwap: number;
};

export type VolumeProfileResponse = {
  symbol: string;
  yahoo_symbol: string;
  proxy_note: string | null;
  session_date: string;
  interval: string;
  bins: number;
  current_price: number;
  poc: number;
  vah: number;
  val: number;
  inside_value_area: boolean;
  retest_poc_signal: boolean;
  total_volume: number;
  levels: VolumeProfileLevel[];
  candles: Candle[];
  vwap?: number | null;
  vwap_series?: VwapPoint[];
  vwap_signals?: VwapSignal[];
};

export type AbsorptionSignal = {
  time: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  absorption_type: "BULLISH_ABSORPTION" | "BEARISH_ABSORPTION" | string;
};

export type AbsorptionResponse = {
  symbol: string;
  yahoo_symbol: string;
  proxy_note: string | null;
  interval: string;
  window: number;
  volume_mult: number;
  estimated: boolean;
  candle_count: number;
  signal_count: number;
  signals: AbsorptionSignal[];
};

export type FootprintLevel = {
  price: number;
  bid: number;
  ask: number;
  buying_imbalance: boolean;
  selling_imbalance: boolean;
};

export type FootprintCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  delta: number;
  poc: number | null;
  buying_imbalances: number;
  selling_imbalances: number;
  levels: FootprintLevel[];
};

export type FootprintResponse = {
  symbol: string;
  yahoo_symbol: string;
  proxy_note: string | null;
  interval: string;
  tick_size: number;
  imbalance_ratio: number;
  estimated: boolean;
  candles: FootprintCandle[];
};

export type QuoteRow = {
  symbol: string;
  yahoo_symbol: string;
  proxy_note: string | null;
  name: string | null;
  price: number;
  prev_close: number;
  change: number;
  change_pct: number;
  as_of: string;
};

export type QuotesResponse = {
  count: number;
  quotes: QuoteRow[];
  errors: Array<{ symbol: string; error: string }>;
};

export type SearchResult = {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
};

export type MomentumHit = {
  symbol: string;
  name: string | null;
  price: number;
  prev_close: number;
  gap_pct: number;
  volume: number;
  avg_volume: number;
  rvol: number;
};

export type MomentumScanResponse = {
  as_of: string;
  delayed: boolean;
  source: string;
  filters: {
    min_gap_pct: number;
    min_rvol: number;
    min_price: number;
    max_price: number;
  };
  universe_size: number;
  scanned: number;
  hit_count: number;
  hits: MomentumHit[];
  errors: Array<{ symbol: string; error: string }>;
};

export type ForecastCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type ForecastUnavailable = {
  available: false;
  reason?: string;
  ticker: string;
  yahoo_symbol?: string;
  proxy_note?: string | null;
  message: string;
  install_hint?: string;
  model?: string;
};

export type ForecastAvailable = {
  available: true;
  ticker: string;
  yahoo_symbol: string;
  proxy_note: string | null;
  interval: string;
  lookback: number;
  pred_len: number;
  model: string;
  tokenizer?: string;
  delayed: boolean;
  source: string;
  disclaimer: string;
  history: ForecastCandle[];
  forecast: ForecastCandle[];
};

export type ForecastResponse = ForecastUnavailable | ForecastAvailable;

export function isForecastUnavailable(
  data: ForecastResponse,
): data is ForecastUnavailable {
  return data.available === false;
}

export type WatchSignal = AbsorptionSignal & {
  symbol: string;
  yahoo_symbol?: string;
};

export type WatchlistSignalsResponse = {
  interval: string;
  window: number;
  volume_mult: number;
  estimated: boolean;
  scanned: number;
  per_symbol: Array<{
    symbol: string;
    yahoo_symbol?: string;
    proxy_note?: string | null;
    signal_count: number;
    latest: AbsorptionSignal | null;
    signals: AbsorptionSignal[];
  }>;
  signals: WatchSignal[];
  errors: Array<{ symbol: string; error: string }>;
};

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const json = await res.json();
      detail = json.detail ?? JSON.stringify(json);
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json() as Promise<T>;
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const json = await res.json();
      detail = json.detail ?? JSON.stringify(json);
    } catch {
      /* ignore */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json() as Promise<T>;
}

export type AlertSeverity = "info" | "warn" | "critical";

export type LabAlert = {
  id: string;
  symbol: string;
  rule: string;
  severity: AlertSeverity;
  message: string;
  payload?: Record<string, unknown>;
  created_at: number;
  read: boolean;
};

export type AlertsListResponse = {
  alerts: LabAlert[];
  unread: number;
  count: number;
};

export type AlertsRiskResponse =
  | {
      available: false;
      reason?: string;
      message?: string;
    }
  | {
      available: true;
      paper: boolean;
      account: {
        equity: number;
        cash: number;
        buying_power: number;
        multiplier: number;
        long_market_value: number;
        short_market_value: number;
        margin_used_pct: number;
        day_pl_pct: number;
        status?: string;
        pattern_day_trader?: boolean;
      };
      positions: Array<{
        symbol: string;
        qty: number;
        side?: string;
        market_value: number;
        unrealized_pl: number;
        unrealized_plpc: number;
        avg_entry_price: number;
        current_price: number;
        has_stop_loss: boolean;
      }>;
      positions_without_stop: Array<{
        symbol: string;
        qty: number;
        market_value: number;
        unrealized_plpc: number;
      }>;
      positions_without_stop_count: number;
      open_orders: number;
    };
