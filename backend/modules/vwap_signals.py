"""
Session VWAP with breakout / pullback signals.

Breakout: close crosses VWAP with elevated volume.
Pullback: after a breakout, price retests VWAP while holding the breakout side.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _bar_time(ts: pd.Timestamp) -> int:
    offset = ts.utcoffset().total_seconds() if ts.utcoffset() else 0
    return int(ts.timestamp() + offset)


def compute_vwap_and_signals(
    session: pd.DataFrame,
    vol_mult: float = 1.5,
    vol_sma_window: int = 20,
) -> dict[str, Any]:
    """
    Compute cumulative session VWAP and breakout/pullback events.

    `session` must include Open/High/Low/Close/Volume with a DatetimeIndex.
    """
    if session is None or session.empty:
        return {"vwap": None, "vwap_series": [], "vwap_signals": []}

    required = {"High", "Low", "Close", "Volume"}
    if not required.issubset(session.columns):
        raise ValueError("Session bars missing OHLC/Volume for VWAP.")

    high = session["High"].astype(float)
    low = session["Low"].astype(float)
    close = session["Close"].astype(float)
    volume = session["Volume"].astype(float).clip(lower=0.0)
    typical = (high + low + close) / 3.0

    cum_pv = (typical * volume).cumsum()
    cum_vol = volume.cumsum().replace(0, np.nan)
    vwap = cum_pv / cum_vol
    vwap = vwap.ffill()

    # Prior-bar SMA so the breakout bar's own spike does not inflate the baseline.
    vol_sma = (
        volume.shift(1)
        .rolling(vol_sma_window, min_periods=max(3, vol_sma_window // 4))
        .mean()
    )

    series: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []
    last_breakout: str | None = None  # "up" | "down"

    closes = close.to_numpy(dtype=float)
    vwaps = vwap.to_numpy(dtype=float)
    highs = high.to_numpy(dtype=float)
    lows = low.to_numpy(dtype=float)
    vols = volume.to_numpy(dtype=float)
    smas = vol_sma.to_numpy(dtype=float)
    index = list(session.index)

    for i, ts in enumerate(index):
        v = float(vwaps[i]) if np.isfinite(vwaps[i]) else None
        t = _bar_time(ts)
        if v is not None:
            series.append({"time": t, "vwap": round(v, 6)})

        if i == 0 or v is None or not np.isfinite(closes[i]):
            continue

        prev_c = float(closes[i - 1])
        prev_v = float(vwaps[i - 1]) if np.isfinite(vwaps[i - 1]) else v
        c = float(closes[i])
        h = float(highs[i])
        lo = float(lows[i])
        vol = float(vols[i])
        sma = float(smas[i]) if np.isfinite(smas[i]) else None
        vol_ok = sma is not None and sma > 0 and vol >= vol_mult * sma

        # Breakout up / down across VWAP with volume confirmation.
        if vol_ok and prev_c <= prev_v and c > v:
            signals.append(
                {
                    "time": t,
                    "price": round(c, 6),
                    "type": "VWAP_BREAKOUT_UP",
                }
            )
            last_breakout = "up"
        elif vol_ok and prev_c >= prev_v and c < v:
            signals.append(
                {
                    "time": t,
                    "price": round(c, 6),
                    "type": "VWAP_BREAKOUT_DOWN",
                }
            )
            last_breakout = "down"

        # Pullback: retest VWAP while closing on the breakout side.
        if last_breakout == "up" and lo <= v <= h and c >= v:
            # Avoid duplicate pullback on the same breakout bar.
            if signals and signals[-1]["time"] == t and signals[-1]["type"].startswith(
                "VWAP_BREAKOUT"
            ):
                pass
            else:
                signals.append(
                    {
                        "time": t,
                        "price": round(v, 6),
                        "type": "VWAP_PULLBACK_LONG",
                    }
                )
                last_breakout = None
        elif last_breakout == "down" and lo <= v <= h and c <= v:
            if signals and signals[-1]["time"] == t and signals[-1]["type"].startswith(
                "VWAP_BREAKOUT"
            ):
                pass
            else:
                signals.append(
                    {
                        "time": t,
                        "price": round(v, 6),
                        "type": "VWAP_PULLBACK_SHORT",
                    }
                )
                last_breakout = None

    final_vwap = None
    if series:
        final_vwap = series[-1]["vwap"]

    return {
        "vwap": final_vwap,
        "vwap_series": series,
        "vwap_signals": signals,
    }
