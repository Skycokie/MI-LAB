"""
Estimated order-flow from Yahoo Finance 1-minute bars.

Yahoo does not expose aggressor side, so we approximate:
  ask_share = (close - low) / (high - low)   # 0.5 when high == low
  ask_volume = volume * ask_share
  bid_volume = volume * (1 - ask_share)

Each 1m bar's volume is spread across the price levels between its
low and high. Bars are then aggregated into 5m / 15m candles so that
diagonal footprint imbalances stay meaningful (mixing bars with
different directions prevents every cell from collapsing to the
same ask/bid ratio).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from modules.volume_profile import resolve_symbol

INTERVAL_MINUTES: dict[str, int] = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
}


def exchange_local_unix(ts: pd.Timestamp) -> int:
    """Shift exchange-local wall-clock into a UTC unix stamp for charting."""
    offset = ts.utcoffset().total_seconds() if ts.utcoffset() else 0
    return int(ts.timestamp() + offset)


def nice_tick_size(price_range: float, target_levels: int = 60) -> float:
    """Pick a round tick size so a candle spans ~target_levels bins."""
    if price_range <= 0 or not np.isfinite(price_range):
        return 0.01
    raw = price_range / max(target_levels, 10)
    magnitude = 10 ** np.floor(np.log10(raw))
    residual = raw / magnitude
    if residual <= 1:
        nice = 1.0
    elif residual <= 2:
        nice = 2.0
    elif residual <= 5:
        nice = 5.0
    else:
        nice = 10.0
    return float(nice * magnitude)


def _ask_share(open_: float, high: float, low: float, close: float) -> float:
    span = high - low
    if span <= 0 or not np.isfinite(span):
        return 0.5
    share = (close - low) / span
    return float(np.clip(share, 0.0, 1.0))


def fetch_1m_bars(symbol: str, period: str = "7d") -> tuple[pd.DataFrame, str, str | None]:
    """Download 1-minute bars; drop zero-volume rows."""
    yahoo_symbol, proxy_note = resolve_symbol(symbol)
    tk = yf.Ticker(yahoo_symbol)
    df = tk.history(period=period, interval="1m", auto_adjust=True)
    if df is None or df.empty:
        raise ValueError(f"No 1m data for '{yahoo_symbol}'.")
    if "Volume" not in df.columns:
        raise ValueError(f"No Volume column for '{yahoo_symbol}'.")

    working = df[df["Volume"] > 0].copy()
    if working.empty:
        raise ValueError(
            f"All 1m bars have zero volume for '{yahoo_symbol}'. "
            "Try a CME futures proxy (e.g. ES=F, 6E=F)."
        )
    working = working.rename(
        columns={
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Volume": "volume",
        }
    )
    return working[["open", "high", "low", "close", "volume"]], yahoo_symbol, proxy_note


def estimate_level_volumes(
    bars: pd.DataFrame, tick_size: float
) -> list[dict[str, Any]]:
    """
    Expand each 1m bar into per-level bid/ask volume contributions.

    Returns a list of dicts with keys: time, price, bid, ask, open, high,
    low, close, volume (bar totals repeated per level for aggregation).
    """
    if tick_size <= 0:
        raise ValueError("tick_size must be positive.")

    rows: list[dict[str, Any]] = []
    for ts, bar in bars.iterrows():
        o = float(bar["open"])
        h = float(bar["high"])
        l = float(bar["low"])
        c = float(bar["close"])
        vol = float(bar["volume"])
        if vol <= 0 or not np.isfinite(vol):
            continue

        share = _ask_share(o, h, l, c)
        ask_vol = vol * share
        bid_vol = vol * (1.0 - share)

        # Inclusive grid of levels touched by this bar.
        low_tick = np.floor(l / tick_size) * tick_size
        high_tick = np.ceil(h / tick_size) * tick_size
        # Guard against float drift that would create empty grids.
        if high_tick < low_tick:
            high_tick = low_tick
        levels = np.round(
            np.arange(low_tick, high_tick + tick_size * 0.5, tick_size),
            decimals=10,
        )
        if len(levels) == 0:
            levels = np.array([round(c / tick_size) * tick_size])

        n = len(levels)
        bid_each = bid_vol / n
        ask_each = ask_vol / n
        local_time = exchange_local_unix(ts)

        for price in levels:
            rows.append(
                {
                    "time": local_time,
                    "ts": ts,
                    "price": float(price),
                    "bid": bid_each,
                    "ask": ask_each,
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": vol,
                }
            )
    return rows


def aggregate_candles(
    level_rows: list[dict[str, Any]],
    interval: str = "5m",
) -> pd.DataFrame:
    """
    Bucket 1m contributions into interval candles with OHLC, volume,
    delta and per-level bid/ask stored as nested dicts.
    """
    if interval not in INTERVAL_MINUTES:
        raise ValueError(f"Unsupported interval '{interval}'. Use 1m, 5m or 15m.")
    if not level_rows:
        raise ValueError("No order-flow rows to aggregate.")

    minutes = INTERVAL_MINUTES[interval]
    df = pd.DataFrame(level_rows)
    # Bucket by exchange-local timestamp (already shifted).
    df["bucket"] = (df["time"] // (minutes * 60)) * (minutes * 60)

    candles: list[dict[str, Any]] = []
    for bucket, group in df.groupby("bucket", sort=True):
        # OHLC from the unique 1m bars inside the bucket (not from levels).
        bar_keys = group.drop_duplicates(subset=["ts"]).sort_values("ts")
        o = float(bar_keys["open"].iloc[0])
        h = float(bar_keys["high"].max())
        l = float(bar_keys["low"].min())
        c = float(bar_keys["close"].iloc[-1])
        vol = float(bar_keys["volume"].sum())

        by_price = (
            group.groupby("price", sort=True)[["bid", "ask"]].sum().reset_index()
        )
        levels = [
            {
                "price": round(float(r.price), 10),
                "bid": float(r.bid),
                "ask": float(r.ask),
            }
            for r in by_price.itertuples(index=False)
        ]
        total_ask = float(by_price["ask"].sum())
        total_bid = float(by_price["bid"].sum())
        candles.append(
            {
                "time": int(bucket),
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": vol,
                "delta": total_ask - total_bid,
                "ask_volume": total_ask,
                "bid_volume": total_bid,
                "levels": levels,
            }
        )

    return pd.DataFrame(candles)


def build_orderflow(
    symbol: str,
    interval: str = "5m",
    tick_size: float | None = None,
    period: str = "7d",
) -> dict[str, Any]:
    """
    Full pipeline: 1m download → estimate levels → aggregate candles.

    Returns yahoo_symbol, proxy_note, tick_size, estimated=True, candles.
    """
    bars, yahoo_symbol, proxy_note = fetch_1m_bars(symbol, period=period)

    if tick_size is None:
        span = float(bars["high"].max() - bars["low"].min())
        tick_size = nice_tick_size(span, target_levels=80)

    level_rows = estimate_level_volumes(bars, tick_size=tick_size)
    candles_df = aggregate_candles(level_rows, interval=interval)

    return {
        "symbol": symbol.upper().strip(),
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "interval": interval,
        "tick_size": tick_size,
        "estimated": True,
        "candles": candles_df.to_dict(orient="records"),
    }
