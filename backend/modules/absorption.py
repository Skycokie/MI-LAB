"""
Institutional absorption detector — Effort vs Result.

High volume (effort) with a compressed price range (weak result) signals
that limit-order institutions are absorbing aggressive flow:
  - positive / neutral delta → BULLISH_ABSORPTION (accumulation / support)
  - negative delta          → BEARISH_ABSORPTION (distribution / resistance)
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from modules import disk_cache, orderflow

_CACHE_TTL_SEC = 180


def _safe_float(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def detect_institutional_absorption(
    df: pd.DataFrame,
    window: int = 20,
    volume_mult: float = 1.8,
) -> pd.DataFrame:
    """
    Detect absorption bars from OHLC + volume + delta.

    Required columns: open, high, low, close, volume, delta.
    Returns only rows flagged as BULLISH_ABSORPTION or BEARISH_ABSORPTION,
    with columns open/high/low/close/volume/delta/absorption_type (and time
    when present).
    """
    required = {"open", "high", "low", "close", "volume", "delta"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"DataFrame missing columns: {sorted(missing)}")
    if df.empty:
        cols = ["open", "high", "low", "close", "volume", "delta", "absorption_type"]
        if "time" in df.columns:
            cols = ["time"] + cols
        return pd.DataFrame(columns=cols)

    data = df.copy()
    window = max(5, int(window))

    data["price_range"] = data["high"] - data["low"]
    data["vol_sma"] = data["volume"].rolling(window=window).mean()
    data["vol_std"] = data["volume"].rolling(window=window).std()
    data["range_sma"] = data["price_range"].rolling(window=window).mean()

    # Effort: volume exceeds mean by volume_mult standard deviations.
    high_effort = data["volume"] > (
        data["vol_sma"] + (volume_mult * data["vol_std"].fillna(0))
    )
    # Result: candle range is below its rolling average (price stalls).
    low_result = data["price_range"] < data["range_sma"]

    data["absorption_type"] = "NONE"
    bullish = high_effort & low_result & (data["delta"] >= 0)
    bearish = high_effort & low_result & (data["delta"] < 0)
    data.loc[bullish, "absorption_type"] = "BULLISH_ABSORPTION"
    data.loc[bearish, "absorption_type"] = "BEARISH_ABSORPTION"

    cols = ["open", "high", "low", "close", "volume", "delta", "absorption_type"]
    if "time" in data.columns:
        cols = ["time"] + cols
    return data.loc[data["absorption_type"] != "NONE", cols].copy()


def get_absorption_signals(
    symbol: str,
    interval: str = "5m",
    window: int = 20,
    volume_mult: float = 1.8,
    limit: int = 20,
    force: bool = False,
) -> dict[str, Any]:
    """
    Run absorption detection on estimated order-flow candles for a ticker.
    """
    limit = max(1, min(int(limit), 100))
    cache_key = f"absorption:{symbol.upper()}:{interval}:{window}:{volume_mult}:{limit}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    of = orderflow.build_orderflow(symbol, interval=interval)
    candles = of["candles"]
    if not candles:
        raise ValueError(f"No candles available for '{symbol}'.")

    frame = pd.DataFrame(candles)
    detected = detect_institutional_absorption(
        frame, window=window, volume_mult=volume_mult
    )

    signals: list[dict[str, Any]] = []
    for _, row in detected.iterrows():
        t = _safe_float(row.get("time"))
        signals.append(
            {
                "time": int(t) if t is not None else None,
                "open": round(float(row["open"]), 6),
                "high": round(float(row["high"]), 6),
                "low": round(float(row["low"]), 6),
                "close": round(float(row["close"]), 6),
                "volume": round(float(row["volume"]), 2),
                "delta": round(float(row["delta"]), 2),
                "absorption_type": str(row["absorption_type"]),
            }
        )

    # Keep the most recent `limit` signals (detected is chronological).
    signals = signals[-limit:]

    payload: dict[str, Any] = {
        "symbol": of["symbol"],
        "yahoo_symbol": of["yahoo_symbol"],
        "proxy_note": of["proxy_note"],
        "interval": interval,
        "window": window,
        "volume_mult": volume_mult,
        "estimated": True,
        "candle_count": len(candles),
        "signal_count": len(signals),
        "signals": signals,
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
