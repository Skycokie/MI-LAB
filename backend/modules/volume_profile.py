"""
Volume Profile for the prior trading session.

Builds a price histogram from intraday bars, then derives:
  - POC  (Point of Control) — highest-volume price bin
  - VAH / VAL (Value Area High / Low) — range covering ~70% of volume

Yahoo Forex spot (* =X) usually has zero volume, so FX symbols are mapped
to CME futures proxies. Equity indices can use ES=F / NQ=F or ETFs.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from modules import disk_cache
from modules.vwap_signals import compute_vwap_and_signals

_CACHE_TTL_SEC = 300

# Map common forex / index aliases → Yahoo symbols with real volume.
SYMBOL_PROXY: dict[str, str] = {
    "EUR": "6E=F",
    "EURUSD": "6E=F",
    "EURUSD=X": "6E=F",
    "GBP": "6B=F",
    "GBPUSD": "6B=F",
    "GBPUSD=X": "6B=F",
    "JPY": "6J=F",
    "USDJPY": "6J=F",
    "USDJPY=X": "6J=F",
    "AUD": "6A=F",
    "AUDUSD": "6A=F",
    "AUDUSD=X": "6A=F",
    "CAD": "6C=F",
    "USDCAD": "6C=F",
    "USDCAD=X": "6C=F",
    "CHF": "6S=F",
    "USDCHF": "6S=F",
    "USDCHF=X": "6S=F",
    "SPX": "ES=F",
    "SP500": "ES=F",
    "^GSPC": "ES=F",
    "NDX": "NQ=F",
    "^NDX": "NQ=F",
    "NASDAQ": "NQ=F",
    # CFD-style tickers (Trading212 / broker suffixes) → Yahoo Finance
    "NVDA.US": "NVDA",
    "PTC.US": "PTC",
    "ADSK.US": "ADSK",
    "SIE.DE": "SIE.DE",
    "DSY.FR": "DSY.PA",
    "DSY.PA": "DSY.PA",
    "TSLA.US": "TSLA",
    "TER.US": "TER",
    "PH.US": "PH",
    "EMR.US": "EMR",
    "ROK.US": "ROK",
    "RRX.US": "RRX",
    # Moog Inc Class A — brokers: MOGA.U / MOG.A ; Yahoo: MOG-A
    "MOGA.U": "MOG-A",
    "MOGA.US": "MOG-A",
    "MOG.A": "MOG-A",
    "MOG.A.US": "MOG-A",
    "MOG-A": "MOG-A",
}

# Broker venue suffix → Yahoo Finance exchange suffix
_CFD_SUFFIX_MAP: dict[str, str] = {
    "US": "",  # strip → bare ticker
    "DE": "DE",  # Xetra / Frankfurt
    "FR": "PA",  # Euronext Paris (brokers use .FR, Yahoo uses .PA)
    "PA": "PA",
    "UK": "L",
    "L": "L",
}


def _map_cfd_suffix(raw: str) -> tuple[str, str | None]:
    """Convert NVDA.US / DSY.FR style CFD labels to Yahoo symbols."""
    if "." not in raw:
        return raw, None
    base, suffix = raw.rsplit(".", 1)
    if not base or suffix not in _CFD_SUFFIX_MAP:
        return raw, None
    mapped_suffix = _CFD_SUFFIX_MAP[suffix]
    yahoo = base if not mapped_suffix else f"{base}.{mapped_suffix}"
    if yahoo == raw:
        return raw, None
    return yahoo, f"CFD {raw} → {yahoo}"


def resolve_symbol(symbol: str) -> tuple[str, str | None]:
    """Return (yahoo_symbol, proxy_note_or_None)."""
    raw = symbol.strip().upper()
    candidates = [raw, symbol.strip()]
    for key in candidates:
        upper = key.upper()
        if upper in SYMBOL_PROXY:
            target = SYMBOL_PROXY[upper]
            return target, f"Mapped {upper} → {target}"
    yahoo, note = _map_cfd_suffix(raw)
    return yahoo, note


def _value_area(
    bin_centers: np.ndarray, volumes: np.ndarray, pct: float = 0.70
) -> tuple[float, float, float]:
    """
    Expand from POC alternating above/below until `pct` of total volume
    is covered. Returns (poc, vah, val).
    """
    if len(volumes) == 0 or volumes.sum() <= 0:
        raise ValueError("Empty volume histogram.")

    poc_idx = int(np.argmax(volumes))
    poc = float(bin_centers[poc_idx])
    target = float(volumes.sum()) * pct

    included = {poc_idx}
    covered = float(volumes[poc_idx])
    lo = poc_idx
    hi = poc_idx

    while covered < target and (lo > 0 or hi < len(volumes) - 1):
        next_lo = lo - 1 if lo > 0 else None
        next_hi = hi + 1 if hi < len(volumes) - 1 else None
        vol_lo = float(volumes[next_lo]) if next_lo is not None else -1.0
        vol_hi = float(volumes[next_hi]) if next_hi is not None else -1.0

        # Prefer the side with more volume; tie → expand both if available.
        if vol_hi >= vol_lo and next_hi is not None:
            included.add(next_hi)
            covered += vol_hi
            hi = next_hi
        elif next_lo is not None:
            included.add(next_lo)
            covered += vol_lo
            lo = next_lo
        elif next_hi is not None:
            included.add(next_hi)
            covered += vol_hi
            hi = next_hi
        else:
            break

    idx = sorted(included)
    val = float(bin_centers[idx[0]])
    vah = float(bin_centers[idx[-1]])
    return poc, vah, val


def compute_volume_profile(
    symbol: str,
    bins: int = 40,
    interval: str = "5m",
    force: bool = False,
) -> dict[str, Any]:
    """
    Volume profile of the previous completed session (or last available day).

    Uses yfinance intraday history (period=5d) and filters to the last
    full calendar trading day present in the series.
    """
    yahoo_symbol, proxy_note = resolve_symbol(symbol)
    # v2: payload includes session VWAP + breakout/pullback signals.
    cache_key = f"volume_profile:v2:{yahoo_symbol}:{bins}:{interval}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    tk = yf.Ticker(yahoo_symbol)
    # 5d of 5m bars is enough to isolate the prior session.
    df = tk.history(period="5d", interval=interval, auto_adjust=True)
    if df is None or df.empty:
        raise ValueError(f"No intraday data for '{yahoo_symbol}'.")

    if "Volume" not in df.columns:
        raise ValueError(f"No Volume column for '{yahoo_symbol}'.")

    # Drop zero-volume bars (common on illiquid / FX spot).
    working = df[df["Volume"] > 0].copy()
    if working.empty:
        raise ValueError(
            f"All bars have zero volume for '{yahoo_symbol}'. "
            "Try a CME futures proxy (e.g. 6E=F, ES=F)."
        )

    # Group by calendar date (exchange tz already applied by yfinance).
    working["session"] = working.index.tz_localize(None).normalize()
    sessions = sorted(working["session"].unique())
    if len(sessions) >= 2:
        # Prefer the previous completed session (not today if today is partial).
        today = pd.Timestamp(date.today())
        prior_candidates = [s for s in sessions if s < today]
        session_day = prior_candidates[-1] if prior_candidates else sessions[-2]
    else:
        session_day = sessions[-1]

    session = working[working["session"] == session_day]
    if session.empty:
        raise ValueError("Could not isolate a prior session.")

    prices = ((session["High"] + session["Low"]) / 2.0).to_numpy(dtype=float)
    volumes = session["Volume"].to_numpy(dtype=float)

    n_bins = max(10, min(int(bins), 200))
    hist, edges = np.histogram(prices, bins=n_bins, weights=volumes)
    centers = (edges[:-1] + edges[1:]) / 2.0

    poc, vah, val = _value_area(centers, hist, pct=0.70)

    # Current price from latest available bar (any recent day).
    current = float(df["Close"].iloc[-1])
    inside_va = val <= current <= vah
    # Institutional heuristic: price exited VA and returned — often retests POC.
    retest_poc = inside_va and (
        abs(current - poc) / poc < 0.003 if poc else False
    )

    levels = [
        {
            "price": round(float(centers[i]), 4),
            "volume": int(hist[i]),
            "is_poc": bool(abs(centers[i] - poc) < 1e-9),
            "in_value_area": bool(val <= centers[i] <= vah),
        }
        for i in range(len(centers))
        if hist[i] > 0
    ]

    # Candles for the price chart: prior session + everything after it.
    # Timestamps are shifted to exchange-local wall-clock time (the chart
    # library renders UTC), so the axis reads like the exchange session.
    local_days = df.index.tz_localize(None).normalize()
    recent = df[local_days >= session_day]
    candles = []
    for ts, bar in recent.iterrows():
        offset = ts.utcoffset().total_seconds() if ts.utcoffset() else 0
        candles.append(
            {
                "time": int(ts.timestamp() + offset),
                "open": round(float(bar["Open"]), 4),
                "high": round(float(bar["High"]), 4),
                "low": round(float(bar["Low"]), 4),
                "close": round(float(bar["Close"]), 4),
                "session": str(pd.Timestamp(ts).tz_localize(None).date()),
            }
        )

    vwap_payload = compute_vwap_and_signals(session)

    payload: dict[str, Any] = {
        "symbol": symbol.upper().strip(),
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "session_date": str(pd.Timestamp(session_day).date()),
        "interval": interval,
        "bins": n_bins,
        "current_price": round(current, 4),
        "poc": round(poc, 4),
        "vah": round(vah, 4),
        "val": round(val, 4),
        "inside_value_area": inside_va,
        "retest_poc_signal": retest_poc,
        "total_volume": int(volumes.sum()),
        "levels": levels,
        "candles": candles,
        "vwap": vwap_payload.get("vwap"),
        "vwap_series": vwap_payload.get("vwap_series") or [],
        "vwap_signals": vwap_payload.get("vwap_signals") or [],
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
