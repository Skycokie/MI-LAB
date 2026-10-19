"""
Watchlist alert scanner: breakout 20d, RVOL×2, RSI 30–70, 3%/30m move, news.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

import numpy as np
import pandas as pd
import requests

from modules import alerts_store, market_data
from modules.volume_profile import resolve_symbol

logger = logging.getLogger(__name__)

_SCAN_LOCK = threading.Lock()
_HTTP_TIMEOUT = 12
_ALPACA_DATA = "https://data.alpaca.markets"
_NEWS_KEYWORDS = (
    "surge",
    "plung",
    "crash",
    "soar",
    "breakout",
    "halt",
    "sec ",
    "lawsuit",
    "earnings",
    "guidance",
    "upgrade",
    "downgrade",
    "acquisition",
    "merger",
    "bankrupt",
    "fda",
    "investigation",
)


def _rsi(closes: pd.Series, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    delta = closes.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    val = float(rsi.iloc[-1])
    if np.isnan(val):
        return None
    return val


def _maybe_alert(
    symbol: str,
    rule: str,
    severity: str,
    message: str,
    payload: dict[str, Any] | None,
    fired: list[dict[str, Any]],
) -> None:
    if not alerts_store.can_fire(symbol, rule):
        return
    alert = alerts_store.insert_alert(symbol, rule, severity, message, payload)
    fired.append(alert)


def _bars_intraday(display: str, lookback: int = 120) -> tuple[pd.DataFrame | None, str]:
    yahoo, _ = resolve_symbol(display)
    try:
        df, src = market_data.fetch_history(display, yahoo, "5m", lookback)
        if df is None or len(df) < 32:
            return None, src
        return df, src
    except Exception as exc:
        logger.warning("intraday bars %s: %s", display, exc)
        return None, "none"


def _bars_daily(display: str, lookback: int = 40) -> pd.DataFrame | None:
    yahoo, _ = resolve_symbol(display)
    # Prefer Alpaca daily for US equities; else Yahoo day bars.
    if market_data.alpaca_configured() and not market_data.is_crypto_symbol(display):
        key = os.getenv("ALPACA_API_KEY_ID", "").strip()
        secret = os.getenv("ALPACA_API_SECRET_KEY", "").strip()
        symbol = display.upper().strip()
        if "." not in symbol and "=" not in symbol and not market_data.is_forex_symbol(symbol):
            try:
                from datetime import datetime, timedelta, timezone

                start = (datetime.now(timezone.utc) - timedelta(days=45)).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                )
                resp = requests.get(
                    f"{_ALPACA_DATA}/v2/stocks/{symbol}/bars",
                    headers={
                        "APCA-API-KEY-ID": key,
                        "APCA-API-SECRET-KEY": secret,
                    },
                    params={
                        "timeframe": "1Day",
                        "start": start,
                        "limit": lookback + 5,
                        "adjustment": "split",
                        "feed": "iex",
                        "sort": "asc",
                    },
                    timeout=_HTTP_TIMEOUT,
                )
                if resp.status_code == 200:
                    bars = resp.json().get("bars") or []
                    if bars:
                        rows = [
                            {
                                "open": float(b["o"]),
                                "high": float(b["h"]),
                                "low": float(b["l"]),
                                "close": float(b["c"]),
                                "volume": float(b.get("v") or 0),
                            }
                            for b in bars
                        ]
                        idx = [pd.Timestamp(b["t"]) for b in bars]
                        return pd.DataFrame(rows, index=pd.DatetimeIndex(idx))
            except Exception as exc:
                logger.warning("alpaca daily %s: %s", display, exc)

    try:
        import yfinance as yf

        hist = yf.Ticker(yahoo).history(period="3mo", interval="1d", auto_adjust=True)
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
        return hist[["open", "high", "low", "close", "volume"]].dropna()
    except Exception as exc:
        logger.warning("yahoo daily %s: %s", display, exc)
        return None


def _check_news(symbol: str, fired: list[dict[str, Any]]) -> None:
    if not market_data.alpaca_configured():
        return
    # Skip pure crypto / forex for Alpaca news
    if market_data.is_crypto_symbol(symbol):
        return
    if market_data.is_forex_symbol(symbol):
        return
    key = os.getenv("ALPACA_API_KEY_ID", "").strip()
    secret = os.getenv("ALPACA_API_SECRET_KEY", "").strip()
    try:
        resp = requests.get(
            f"{_ALPACA_DATA}/v1beta1/news",
            headers={
                "APCA-API-KEY-ID": key,
                "APCA-API-SECRET-KEY": secret,
            },
            params={"symbols": symbol.upper(), "limit": 5},
            timeout=_HTTP_TIMEOUT,
        )
        if resp.status_code != 200:
            return
        news = resp.json().get("news") or []
    except Exception as exc:
        logger.warning("news %s: %s", symbol, exc)
        return

    for article in news[:3]:
        headline = str(article.get("headline") or "")
        summary = str(article.get("summary") or "")
        text = f"{headline} {summary}".lower()
        if not any(k in text for k in _NEWS_KEYWORDS):
            continue
        _maybe_alert(
            symbol,
            "news_major",
            "warn",
            f"Știre: {headline[:160]}",
            {
                "headline": headline,
                "url": article.get("url"),
                "created_at": article.get("created_at"),
            },
            fired,
        )
        break


def scan_symbol(symbol: str) -> list[dict[str, Any]]:
    fired: list[dict[str, Any]] = []
    display = symbol.upper().strip()

    intraday, _src = _bars_intraday(display, lookback=120)
    if intraday is not None and len(intraday) >= 25:
        close = intraday["close"]
        vol = intraday["volume"]

        # RVOL ×2 vs SMA20 of prior bars
        if len(vol) >= 21:
            sma = float(vol.iloc[-21:-1].mean())
            last_v = float(vol.iloc[-1])
            if sma > 0 and last_v >= 2.0 * sma:
                rvol = last_v / sma
                _maybe_alert(
                    display,
                    "rvol_spike",
                    "warn",
                    f"Volum {rvol:.1f}× media ultimelor 20 bare",
                    {"rvol": round(rvol, 2), "volume": last_v, "sma20": sma},
                    fired,
                )

        # RSI 14
        rsi_val = _rsi(close, 14)
        if rsi_val is not None and (rsi_val < 30 or rsi_val > 70):
            side = "oversold" if rsi_val < 30 else "overbought"
            _maybe_alert(
                display,
                "rsi_extreme",
                "warn",
                f"RSI(14)={rsi_val:.1f} ({side}) — în afara 30–70",
                {"rsi": round(rsi_val, 2), "side": side},
                fired,
            )

        # 3% move in ~30 minutes (6 × 5m bars)
        if len(close) >= 7:
            c_now = float(close.iloc[-1])
            c_ago = float(close.iloc[-7])
            if c_ago > 0:
                pct = (c_now / c_ago - 1.0) * 100.0
                if abs(pct) >= 3.0:
                    _maybe_alert(
                        display,
                        "move_30m",
                        "critical",
                        f"Mișcare {pct:+.2f}% în ~30 minute",
                        {"pct_30m": round(pct, 2), "close": c_now},
                        fired,
                    )

    # 20-day high/low breakout (exclude today from range)
    daily = _bars_daily(display, lookback=40)
    if daily is not None and len(daily) >= 22:
        window = daily.iloc[-21:-1]
        hi = float(window["high"].max())
        lo = float(window["low"].min())
        last_close = float(daily["close"].iloc[-1])
        if last_close > hi:
            _maybe_alert(
                display,
                "breakout_20d_high",
                "info",
                f"Sparge maximul pe 20 zile ({hi:.4g}) — close {last_close:.4g}",
                {"high_20d": hi, "close": last_close},
                fired,
            )
        elif last_close < lo:
            _maybe_alert(
                display,
                "breakout_20d_low",
                "warn",
                f"Sparge minimul pe 20 zile ({lo:.4g}) — close {last_close:.4g}",
                {"low_20d": lo, "close": last_close},
                fired,
            )

    _check_news(display, fired)
    return fired


def run_scan() -> dict[str, Any]:
    """Scan entire server watchlist. Serialized."""
    if not _SCAN_LOCK.acquire(blocking=False):
        return {"ok": False, "reason": "scan_in_progress", "fired": [], "scanned": 0}

    try:
        watch = alerts_store.get_watchlist()
        all_fired: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for item in watch:
            sym = item["symbol"]
            try:
                all_fired.extend(scan_symbol(sym))
            except Exception as exc:
                logger.exception("scan %s failed", sym)
                errors.append({"symbol": sym, "error": str(exc)})
        return {
            "ok": True,
            "scanned": len(watch),
            "fired_count": len(all_fired),
            "fired": all_fired,
            "errors": errors,
            "unread": alerts_store.unread_count(),
        }
    finally:
        _SCAN_LOCK.release()
