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
    # Index CFDs (Trading212 / broker labels) → Yahoo futures / cash indices
    "USA500": "ES=F",
    "US500": "ES=F",
    "SPX500": "ES=F",
    "US100": "NQ=F",
    "NAS100": "NQ=F",
    "USTECH": "NQ=F",
    "US30": "YM=F",
    "DJ30": "YM=F",
    "WALLSTREET": "YM=F",
    # EU/Asia cash indices: Yahoo Volume is often 0 → synthetic range-volume in VP/OF.
    "GER40": "^GDAXI",
    "DE40": "^GDAXI",
    "DAX40": "^GDAXI",
    "DAX": "^GDAXI",
    "UK100": "^FTSE",
    "FTSE100": "^FTSE",
    "FRA40": "^FCHI",
    "CAC40": "^FCHI",
    "JPN225": "^N225",
    "JP225": "^N225",
    "NI225": "^N225",
    "EU50": "^STOXX50E",
    "EUSTX50": "^STOXX50E",
    "AUS200": "^AXJO",
    "AU200": "^AXJO",
    "HK50": "^HSI",
    "HKCHINA50": "^HSI",
    "SPA35": "^IBEX",
    "IBEX35": "^IBEX",
    "SWI20": "^SSMI",
    "SMI20": "^SSMI",
    "ITA40": "FTSEMIB.MI",
    "GOLD": "GC=F",
    "XAUUSD": "GC=F",
    "OIL": "CL=F",
    "USOIL": "CL=F",
    "BRENT": "BZ=F",
    # Sentiment / macro indicators
    "VIX": "^VIX",
    "US10Y": "^TNX",
    "TNX": "^TNX",
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
    # Crypto CFDs (broker .US) → Yahoo crypto tickers
    "BTC.US": "BTC-USD",
    "ETH.US": "ETH-USD",
    "SOL.US": "SOL-USD",
    "XRP.US": "XRP-USD",
    "DOGE.US": "DOGE-USD",
    "ADA.US": "ADA-USD",
    "BNB.US": "BNB-USD",
    "AVAX.US": "AVAX-USD",
    "LINK.US": "LINK-USD",
    "DOT.US": "DOT-USD",
    "LTC.US": "LTC-USD",
    "BCH.US": "BCH-USD",
    "TRX.US": "TRX-USD",
    "TON.US": "TON-USD",
    "SUI.US": "SUI-USD",
    "PEPE.US": "PEPE-USD",
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


_CRYPTO_CFD_BASES = {
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "DOGE",
    "ADA",
    "BNB",
    "AVAX",
    "LINK",
    "DOT",
    "LTC",
    "BCH",
    "TRX",
    "TON",
    "SUI",
    "PEPE",
}


def _map_cfd_suffix(raw: str) -> tuple[str, str | None]:
    """Convert NVDA.US / DSY.FR / BTC.US style CFD labels to Yahoo symbols."""
    if "." not in raw:
        return raw, None
    base, suffix = raw.rsplit(".", 1)
    if not base or suffix not in _CFD_SUFFIX_MAP:
        return raw, None
    # Crypto CFDs quote on Yahoo as BASE-USD (not bare ticker).
    if base in _CRYPTO_CFD_BASES and suffix in {"US", "USD"}:
        yahoo = f"{base}-USD"
        return yahoo, f"Crypto CFD {raw} → {yahoo}"
    mapped_suffix = _CFD_SUFFIX_MAP[suffix]
    yahoo = base if not mapped_suffix else f"{base}.{mapped_suffix}"
    if yahoo == raw:
        return raw, None
    return yahoo, f"CFD {raw} → {yahoo}"


FX_CURRENCIES = frozenset(
    {
        "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
        "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "MXN", "ZAR",
        "TRY", "SGD", "HKD", "CNH", "CNY",
    }
)

# Pairs with a liquid CME currency future (real volume) on Yahoo.
# value = (future symbol, inverted?).  The future quotes USD per foreign
# unit, so USDxxx pairs are the reciprocal (inverted) of the future.
FX_FUTURES: dict[str, tuple[str, bool]] = {
    "EURUSD": ("6E=F", False),
    "GBPUSD": ("6B=F", False),
    "AUDUSD": ("6A=F", False),
    "NZDUSD": ("6N=F", False),
    "USDJPY": ("6J=F", True),
    "USDCAD": ("6C=F", True),
    "USDCHF": ("6S=F", True),
}

FX_TZ = "Europe/Bucharest"  # midnight RO ~ 17:00 New York FX roll-over


def fx_pair(symbol: str) -> str | None:
    """Normalise EURUSD / EUR/USD / EURUSD=X → 'EURUSD', else None."""
    raw = symbol.strip().upper()
    for junk in ("=X", "/", "-", "_", " "):
        raw = raw.replace(junk, "")
    if len(raw) == 6 and raw[:3] in FX_CURRENCIES and raw[3:] in FX_CURRENCIES:
        if raw[:3] != raw[3:]:
            return raw
    return None


def is_fx_pair(symbol: str) -> bool:
    return fx_pair(symbol) is not None


def fx_pip(pair: str) -> float:
    """Pip size: 0.01 for JPY-quoted pairs, else 0.0001."""
    return 0.01 if pair.endswith("JPY") else 0.0001


def resolve_symbol(symbol: str) -> tuple[str, str | None]:
    """Return (yahoo_symbol, proxy_note_or_None)."""
    pair = fx_pair(symbol)
    if pair:
        return f"{pair}=X", None
    raw = symbol.strip().upper()
    candidates = [raw, symbol.strip()]
    for key in candidates:
        upper = key.upper()
        if upper in SYMBOL_PROXY:
            target = SYMBOL_PROXY[upper]
            return target, f"Mapped {upper} → {target}"
    yahoo, note = _map_cfd_suffix(raw)
    return yahoo, note


def ensure_positive_volume(df: pd.DataFrame) -> tuple[pd.DataFrame, bool]:
    """
    Drop zero-volume bars when real volume exists.

    Cash indices (^GDAXI, ^FTSE, …) and some FX spots report Volume=0 on
    Yahoo. In that case synthesize volume from true range so VP / orderflow
    can still run on the correct price scale (not an ETF proxy).
    """
    if "Volume" not in df.columns:
        raise ValueError("No Volume column in OHLCV frame.")

    working = df[df["Volume"] > 0].copy()
    if not working.empty:
        return working, False

    working = df.copy()
    tr = (working["High"] - working["Low"]).abs()
    positive = tr[tr > 0]
    med = float(positive.median()) if len(positive) else 0.0
    if not np.isfinite(med) or med <= 0:
        med = 1e-4
    tr = tr.mask(tr <= 0, med)
    working["Volume"] = tr.astype(float) * 1_000_000.0
    return working, True


def _fx_from_futures(
    pair: str, spot: str, interval: str, period: str
) -> tuple[pd.DataFrame, str] | None:
    """
    Real-volume FX bars: CME currency future, inverted when needed and
    rescaled to the spot price level (the futures carry a small basis).
    """
    fut, inverse = FX_FUTURES[pair]
    f = yf.Ticker(fut).history(period=period, interval=interval, auto_adjust=True)
    if f is None or f.empty or "Volume" not in f.columns or f["Volume"].sum() <= 0:
        return None
    f = f[["Open", "High", "Low", "Close", "Volume"]].copy()
    f = f[(f[["Open", "High", "Low", "Close"]] > 0).all(axis=1)]
    if f.empty:
        return None

    if inverse:
        o, h, l, c = f["Open"], f["High"], f["Low"], f["Close"]
        f["Open"], f["High"], f["Low"], f["Close"] = 1.0 / o, 1.0 / l, 1.0 / h, 1.0 / c

    # Futures→spot basis barely moves intraday: cache it to save a download.
    ratio_key = f"fx_ratio:{pair}"
    cached_ratio = disk_cache.get(ratio_key)
    ratio = (
        float(cached_ratio["r"])
        if isinstance(cached_ratio, dict) and "r" in cached_ratio
        else None
    )
    if ratio is None:
        s = yf.Ticker(spot).history(period=period, interval=interval, auto_adjust=True)
        if s is not None and not s.empty:
            common = f.index.intersection(s.index)
            if len(common) >= 20:
                ratio = float(
                    (s["Close"].loc[common] / f["Close"].loc[common]).tail(300).median()
                )
            else:
                ratio = float(s["Close"].iloc[-1] / f["Close"].iloc[-1])
        if ratio is not None and np.isfinite(ratio) and 0.97 < ratio < 1.03:
            disk_cache.set(ratio_key, {"r": ratio}, 600)
    if ratio is None or not np.isfinite(ratio) or not 0.97 < ratio < 1.03:
        return None
    for col in ("Open", "High", "Low", "Close"):
        f[col] = f[col] * ratio

    note = (
        f"{pair}: volume from CME {fut}"
        f"{' (inverted)' if inverse else ''}, prices rescaled to spot (x{ratio:.5f})"
    )
    return f, note


def _to_fx_tz(df: pd.DataFrame) -> pd.DataFrame:
    """Express FX bars in Romanian local time so a 'session' ~ NY roll-over day."""
    if isinstance(df.index, pd.DatetimeIndex) and df.index.tz is not None:
        out = df.copy()
        out.index = out.index.tz_convert(FX_TZ)
        return out
    return df


def fetch_intraday(
    symbol: str, interval: str, period: str
) -> tuple[pd.DataFrame, str, str | None]:
    """
    Intraday OHLCV (Yahoo column names) for VP / order-flow.

    FX pairs: real volume from the matching CME future when available
    (prices converted to the spot scale); other pairs fall back to the
    spot series, whose zero volume becomes synthetic range-volume.
    Returns (df, yahoo_symbol, proxy_note).
    """
    yahoo_symbol, proxy_note = resolve_symbol(symbol)
    pair = fx_pair(symbol)
    if pair and pair in FX_FUTURES:
        try:
            got = _fx_from_futures(pair, yahoo_symbol, interval, period)
        except Exception:
            got = None
        if got is not None:
            df, note = got
            return _to_fx_tz(df), yahoo_symbol, note

    df = yf.Ticker(yahoo_symbol).history(
        period=period, interval=interval, auto_adjust=True
    )
    if df is None or df.empty:
        raise ValueError(f"No intraday data for '{yahoo_symbol}'.")
    if pair:
        df = _to_fx_tz(df)
    return df, yahoo_symbol, proxy_note


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
    # v3: synthetic range-volume for cash indices with Yahoo Volume=0.
    # v4: FX pairs use CME-future volume rescaled to spot, FX session = RO day.
    fx = is_fx_pair(symbol)
    dp = 6 if fx else 4  # decimals kept in the payload (FX needs sub-pip)
    cache_key = f"volume_profile:v4:{yahoo_symbol}:{bins}:{interval}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    # 5d of 5m bars is enough to isolate the prior session.
    df, yahoo_symbol, proxy_note = fetch_intraday(symbol, interval, "5d")

    if "Volume" not in df.columns:
        raise ValueError(f"No Volume column for '{yahoo_symbol}'.")

    working, synthetic_vol = ensure_positive_volume(df)
    if synthetic_vol:
        note = f"Synthetic range-volume (Yahoo Volume=0 for {yahoo_symbol})"
        proxy_note = f"{proxy_note}; {note}" if proxy_note else note

    # Group by calendar date (exchange tz already applied by yfinance).
    working["session"] = working.index.tz_localize(None).normalize()
    sessions = sorted(working["session"].unique())
    if len(sessions) >= 2:
        # Prefer the previous completed session (not today if today is partial).
        today = pd.Timestamp(date.today())
        prior_candidates = [s for s in sessions if s < today]
        if fx and prior_candidates:
            # Skip stub sessions (e.g. the Sunday-evening open).
            counts = working.groupby("session").size()
            biggest = max(int(counts[s]) for s in prior_candidates)
            prior_candidates = [
                s for s in prior_candidates if counts[s] >= 0.4 * biggest
            ] or prior_candidates
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
        abs(current - poc) / poc < (0.0004 if fx else 0.003) if poc else False
    )

    levels = [
        {
            "price": round(float(centers[i]), dp),
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
                "open": round(float(bar["Open"]), dp),
                "high": round(float(bar["High"]), dp),
                "low": round(float(bar["Low"]), dp),
                "close": round(float(bar["Close"]), dp),
                "session": str(pd.Timestamp(ts).tz_localize(None).date()),
            }
        )

    vwap_payload = compute_vwap_and_signals(session)

    payload: dict[str, Any] = {
        "symbol": symbol.upper().strip(),
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "volume_synthetic": synthetic_vol,
        "session_date": str(pd.Timestamp(session_day).date()),
        "interval": interval,
        "bins": n_bins,
        "current_price": round(current, dp),
        "poc": round(poc, dp),
        "vah": round(vah, dp),
        "val": round(val, dp),
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
