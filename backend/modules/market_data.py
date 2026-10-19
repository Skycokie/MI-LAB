"""
OHLCV history for Kronos Forecast only.

Routing (first success wins):
  1. HTX   — crypto pairs (public klines, no key required)
  2. Alpaca — plain US equity / ETF symbols when Alpaca keys are set
  3. Yahoo  — always available fallback (delayed ~15m)

Other Lab tabs keep calling yfinance directly; this module is Forecast-only.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import requests
import yfinance as yf

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 10

# Display aliases → HTX spot symbols (lowercase, quote USDT).
_HTX_ALIASES: dict[str, str] = {
    "BTC": "btcusdt",
    "BTCUSD": "btcusdt",
    "BTCUSDT": "btcusdt",
    "BTC-USD": "btcusdt",
    "XBT": "btcusdt",
    "ETH": "ethusdt",
    "ETHUSD": "ethusdt",
    "ETHUSDT": "ethusdt",
    "ETH-USD": "ethusdt",
    "SOL": "solusdt",
    "SOLUSD": "solusdt",
    "SOLUSDT": "solusdt",
    "SOL-USD": "solusdt",
    "XRP": "xrpusdt",
    "XRPUSD": "xrpusdt",
    "XRPUSDT": "xrpusdt",
    "XRP-USD": "xrpusdt",
    "DOGE": "dogeusdt",
    "DOGEUSD": "dogeusdt",
    "DOGEUSDT": "dogeusdt",
    "DOGE-USD": "dogeusdt",
    "ADA": "adausdt",
    "ADAUSD": "adausdt",
    "ADAUSDT": "adausdt",
    "ADA-USD": "adausdt",
    "BNB": "bnbusdt",
    "BNBUSDT": "bnbusdt",
    "BNB-USD": "bnbusdt",
    "AVAX": "avaxusdt",
    "AVAXUSDT": "avaxusdt",
    "AVAX-USD": "avaxusdt",
    "LINK": "linkusdt",
    "LINKUSDT": "linkusdt",
    "LINK-USD": "linkusdt",
    "DOT": "dotusdt",
    "DOTUSDT": "dotusdt",
    "DOT-USD": "dotusdt",
    "LTC": "ltcusdt",
    "LTCUSDT": "ltcusdt",
    "LTC-USD": "ltcusdt",
    "BCH": "bchusdt",
    "BCHUSDT": "bchusdt",
    "BCH-USD": "bchusdt",
    "TRX": "trxusdt",
    "TRXUSDT": "trxusdt",
    "TRX-USD": "trxusdt",
    "TON": "tonusdt",
    "TONUSDT": "tonusdt",
    "SUI": "suiusdt",
    "SUIUSDT": "suiusdt",
    "PEPE": "pepeusdt",
    "PEPEUSDT": "pepeusdt",
}

# Forex / index aliases that must not go to Alpaca or HTX.
_FOREX_ALIASES: set[str] = {
    "EUR",
    "EURUSD",
    "EURUSD=X",
    "GBP",
    "GBPUSD",
    "GBPUSD=X",
    "JPY",
    "USDJPY",
    "USDJPY=X",
    "AUD",
    "AUDUSD",
    "AUDUSD=X",
    "CAD",
    "USDCAD",
    "USDCAD=X",
    "CHF",
    "USDCHF",
    "USDCHF=X",
    "SPX",
    "SP500",
}

_ALPACA_TIMEFRAME: dict[str, str] = {
    "1m": "1Min",
    "5m": "5Min",
    "15m": "15Min",
    "30m": "30Min",
    "60m": "1Hour",
    "1h": "1Hour",
}

_HTX_PERIOD: dict[str, str] = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "60m": "60min",
    "1h": "60min",
}

_YF_PERIOD: dict[str, str] = {
    "1m": "7d",
    "2m": "60d",
    "5m": "60d",
    "15m": "60d",
    "30m": "60d",
    "60m": "730d",
    "1h": "730d",
}

_HTX_BASE = "https://api.huobi.pro"

# Extra bars to request so lookback is still met after dropna / session gaps.
_FETCH_PAD = 1.25


def alpaca_configured() -> bool:
    return bool(os.getenv("ALPACA_API_KEY_ID") and os.getenv("ALPACA_API_SECRET_KEY"))


def htx_configured() -> bool:
    """Public HTX klines need no key; always available."""
    return True


def is_forex_symbol(display: str) -> bool:
    return display.upper().strip() in _FOREX_ALIASES


def is_crypto_symbol(display: str) -> bool:
    return _resolve_htx_symbol(display) is not None


def _resolve_htx_symbol(display: str) -> str | None:
    """Map a Lab ticker to an HTX spot symbol, or None if not crypto."""
    raw = display.upper().strip()
    if raw in _FOREX_ALIASES:
        return None
    if raw in _HTX_ALIASES:
        return _HTX_ALIASES[raw]
    # Already an HTX-style pair: BTCUSDT, ethusdt, BTC/USDT
    compact = raw.replace("/", "").replace("-", "").replace("_", "")
    if compact.endswith(("USDT", "USDC", "BTC", "ETH")) and len(compact) >= 6:
        return compact.lower()
    return None


def _normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame | None:
    """Ensure lowercase open/high/low/close/volume columns; return None if empty."""
    if df is None or df.empty:
        return None
    out = df.copy()
    out.columns = [str(c).lower() for c in out.columns]
    need = ["open", "high", "low", "close"]
    if not all(c in out.columns for c in need):
        return None
    if "volume" not in out.columns:
        out["volume"] = 0.0
    out = out.dropna(subset=need)
    if out.empty:
        return None
    out["volume"] = out["volume"].fillna(0.0)
    if not isinstance(out.index, pd.DatetimeIndex):
        out.index = pd.to_datetime(out.index, utc=True)
    return out[["open", "high", "low", "close", "volume"]]


def _lookback_start(interval: str, lookback: int) -> datetime:
    minutes = {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "30m": 30,
        "60m": 60,
        "1h": 60,
    }.get(interval, 5)
    # Equities trade ~6.5h/day and skip weekends. Use a wide calendar
    # window so Monday mornings / holidays still return enough bars.
    bars = int(lookback * _FETCH_PAD) + 50
    trading_minutes = bars * minutes
    # ~1 trading day ≈ 6.5h; pad 5× for nights/weekends, floor at 14 days.
    calendar_minutes = max(trading_minutes * 5, 14 * 24 * 60)
    return datetime.now(timezone.utc) - timedelta(minutes=calendar_minutes)


def _fetch_htx(display: str, interval: str, lookback: int) -> pd.DataFrame | None:
    symbol = _resolve_htx_symbol(display)
    period = _HTX_PERIOD.get(interval)
    if not symbol or not period:
        return None

    size = min(2000, max(32, int(lookback * _FETCH_PAD) + 50))
    url = f"{_HTX_BASE}/market/history/kline"
    params: dict[str, Any] = {
        "symbol": symbol,
        "period": period,
        "size": size,
    }
    try:
        resp = requests.get(url, params=params, timeout=_HTTP_TIMEOUT)
        if resp.status_code != 200:
            logger.warning("HTX %s → HTTP %s: %s", symbol, resp.status_code, resp.text[:200])
            return None
        payload = resp.json()
        if payload.get("status") != "ok":
            logger.warning("HTX %s → status=%s err=%s", symbol, payload.get("status"), payload.get("err-msg"))
            return None
        candles = payload.get("data") or []
    except Exception as exc:
        logger.warning("HTX fetch failed for %s: %s", symbol, exc)
        return None

    if not candles:
        return None

    # HTX returns newest-first; Kronos needs chronological ascending.
    rows: list[dict[str, Any]] = []
    index: list[pd.Timestamp] = []
    for c in reversed(candles):
        try:
            index.append(pd.to_datetime(int(c["id"]), unit="s", utc=True))
            rows.append(
                {
                    "open": float(c["open"]),
                    "high": float(c["high"]),
                    "low": float(c["low"]),
                    "close": float(c["close"]),
                    # `amount` = base-asset volume; `vol` = quote notional.
                    "volume": float(c.get("amount") or c.get("vol") or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not rows:
        return None
    df = pd.DataFrame(rows, index=pd.DatetimeIndex(index))
    return _normalize_ohlcv(df)


def _fetch_alpaca(display: str, interval: str, lookback: int) -> pd.DataFrame | None:
    tf = _ALPACA_TIMEFRAME.get(interval)
    if not tf:
        return None
    key = os.getenv("ALPACA_API_KEY_ID", "").strip()
    secret = os.getenv("ALPACA_API_SECRET_KEY", "").strip()
    if not key or not secret:
        return None

    symbol = display.upper().strip()
    # Skip CFD / forex / crypto — Alpaca is US equities.
    if "." in symbol or "=" in symbol or "/" in symbol:
        return None
    if symbol in _FOREX_ALIASES or _resolve_htx_symbol(symbol):
        return None

    start = _lookback_start(interval, lookback).strftime("%Y-%m-%dT%H:%M:%SZ")
    need_bars = min(10000, int(lookback * _FETCH_PAD) + 100)
    url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
    headers = {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
    }
    # Newest-first so early page cutoffs still give recent bars (weekends/holidays).
    params: dict[str, Any] = {
        "timeframe": tf,
        "start": start,
        "limit": need_bars,
        "adjustment": "split",
        "feed": "iex",
        "sort": "desc",
    }
    all_bars: list[dict[str, Any]] = []
    page_token: str | None = None
    try:
        while True:
            if page_token:
                params["page_token"] = page_token
            resp = requests.get(url, headers=headers, params=params, timeout=_HTTP_TIMEOUT)
            if resp.status_code != 200:
                logger.warning("Alpaca %s → HTTP %s: %s", symbol, resp.status_code, resp.text[:200])
                return None
            payload = resp.json()
            bars = payload.get("bars") or []
            all_bars.extend(bars)
            page_token = payload.get("next_page_token")
            if not page_token or len(all_bars) >= need_bars:
                break
    except Exception as exc:
        logger.warning("Alpaca fetch failed for %s: %s", symbol, exc)
        return None

    if not all_bars:
        return None

    # Restore chronological order for Kronos.
    all_bars = list(reversed(all_bars[:need_bars]))

    rows: list[dict[str, Any]] = []
    index: list[pd.Timestamp] = []
    for b in all_bars:
        try:
            index.append(pd.Timestamp(b["t"]))
            rows.append(
                {
                    "open": float(b["o"]),
                    "high": float(b["h"]),
                    "low": float(b["l"]),
                    "close": float(b["c"]),
                    "volume": float(b.get("v") or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not rows:
        return None
    df = pd.DataFrame(rows, index=pd.DatetimeIndex(index))
    return _normalize_ohlcv(df)


def _fetch_yahoo(yahoo_symbol: str, interval: str) -> pd.DataFrame | None:
    period = _YF_PERIOD.get(interval, "60d")
    try:
        tk = yf.Ticker(yahoo_symbol)
        hist = tk.history(period=period, interval=interval, auto_adjust=True)
    except Exception as exc:
        logger.warning("Yahoo fetch failed for %s: %s", yahoo_symbol, exc)
        return None
    if hist is None or hist.empty:
        return None
    hist = hist.rename(
        columns={
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close",
            "Volume": "volume",
        }
    )
    return _normalize_ohlcv(hist)


def fetch_history(
    display_symbol: str,
    yahoo_symbol: str,
    interval: str,
    lookback: int,
) -> tuple[pd.DataFrame, str]:
    """
    Return (ohlcv_df, source) where source is 'htx' | 'alpaca' | 'yahoo'.

    Raises ValueError only when every provider (including Yahoo) fails.
    """
    display = display_symbol.upper().strip()
    interval = interval.strip().lower()

    # 1) Crypto → HTX spot (public, no key)
    if _resolve_htx_symbol(display) and interval in _HTX_PERIOD:
        df = _fetch_htx(display, interval, lookback)
        if df is not None and len(df) >= 32:
            return df, "htx"

    # 2) US equity → Alpaca
    if (
        alpaca_configured()
        and display not in _FOREX_ALIASES
        and not _resolve_htx_symbol(display)
        and interval in _ALPACA_TIMEFRAME
    ):
        df = _fetch_alpaca(display, interval, lookback)
        if df is not None and len(df) >= 32:
            return df, "alpaca"

    # 3) Yahoo fallback
    df = _fetch_yahoo(yahoo_symbol, interval)
    if df is not None and not df.empty:
        return df, "yahoo"

    raise ValueError(
        f"No OHLCV history for '{display}' ({yahoo_symbol}) from any provider."
    )
