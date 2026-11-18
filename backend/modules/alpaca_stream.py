"""
Alpaca IEX real-time WebSocket collector (free Basic plan).

The Basic plan's REST *historical bars* exclude roughly the latest
15 minutes, but the IEX WebSocket stream is real-time. This collector
subscribes to trades + minute bars for the Lab's index ETF proxies
(QQQ / SPY / DIA), aggregates trades into 1-minute bars in memory, and
lets `market_data.fetch_alpaca_index_bars` stitch those fresh bars onto
the REST/Yahoo history so SMC sees a live edge instead of Yahoo's delay.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

_WS_URL = "wss://stream.data.alpaca.markets/v2/iex"
_SYMBOLS = ["QQQ", "SPY", "DIA"]
_MAX_BARS_PER_SYMBOL = 6000

_lock = threading.Lock()
_bars: dict[str, dict[pd.Timestamp, dict[str, float]]] = {s: {} for s in _SYMBOLS}
_status: dict[str, Any] = {
    "connected": False,
    "subscribed": [],
    "last_message_at": None,
    "last_trade_at": None,
    "trades_seen": 0,
    "error": None,
}


def _floor_minute(ts: pd.Timestamp) -> pd.Timestamp:
    return ts.floor("min")


def _record_trade(symbol: str, price: float, size: float, ts: pd.Timestamp) -> None:
    minute = _floor_minute(ts)
    with _lock:
        book = _bars.setdefault(symbol, {})
        bar = book.get(minute)
        if bar is None:
            book[minute] = {
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": size,
            }
        else:
            bar["high"] = max(bar["high"], price)
            bar["low"] = min(bar["low"], price)
            bar["close"] = price
            bar["volume"] += size
        if len(book) > _MAX_BARS_PER_SYMBOL:
            for old in sorted(book)[: len(book) - _MAX_BARS_PER_SYMBOL]:
                del book[old]
        _status["trades_seen"] = int(_status.get("trades_seen") or 0) + 1
        _status["last_trade_at"] = ts.isoformat()


def _record_bar(symbol: str, msg: dict[str, Any]) -> None:
    try:
        ts = pd.Timestamp(msg["t"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        bar = {
            "open": float(msg["o"]),
            "high": float(msg["h"]),
            "low": float(msg["l"]),
            "close": float(msg["c"]),
            "volume": float(msg.get("v") or 0),
        }
    except (KeyError, TypeError, ValueError):
        return
    with _lock:
        _bars.setdefault(symbol, {})[ts] = bar


def get_bars(symbol: str) -> pd.DataFrame | None:
    """Collected 1-minute bars for one proxy symbol (chronological)."""
    with _lock:
        book = dict(_bars.get(symbol.upper(), {}))
    if not book:
        return None
    df = pd.DataFrame.from_dict(book, orient="index")
    df.index = pd.DatetimeIndex(df.index)
    df = df.sort_index()
    return df[["open", "high", "low", "close", "volume"]]


def status() -> dict[str, Any]:
    with _lock:
        counts = {s: len(b) for s, b in _bars.items()}
        snapshot = dict(_status)
    snapshot["bars_collected"] = counts
    return snapshot


async def run_forever() -> None:
    """Reconnecting WebSocket loop; run as a background task from lifespan."""
    # Alpaca Basic allows ONE IEX WebSocket per account. Set
    # ALPACA_STREAM_DISABLED=1 on secondary deployments (e.g. Railway)
    # so the primary (local) backend owns the live connection.
    if os.getenv("ALPACA_STREAM_DISABLED", "").strip() == "1":
        logger.info("alpaca stream disabled via ALPACA_STREAM_DISABLED=1")
        with _lock:
            _status["error"] = "disabled via ALPACA_STREAM_DISABLED"
        return
    key = os.getenv("ALPACA_API_KEY_ID", "").strip()
    secret = os.getenv("ALPACA_API_SECRET_KEY", "").strip()
    if not key or not secret:
        logger.info("alpaca stream disabled: API keys not configured")
        return

    import websockets

    backoff = 5
    while True:
        try:
            async with websockets.connect(_WS_URL, ping_interval=20, ping_timeout=20) as ws:
                await ws.recv()  # welcome
                await ws.send(json.dumps({"action": "auth", "key": key, "secret": secret}))
                auth_resp = json.loads(await ws.recv())
                if not any(m.get("T") == "success" and m.get("msg") == "authenticated" for m in auth_resp):
                    raise RuntimeError(f"alpaca stream auth failed: {auth_resp}")
                await ws.send(
                    json.dumps(
                        {
                            "action": "subscribe",
                            "trades": _SYMBOLS,
                            "bars": _SYMBOLS,
                        }
                    )
                )
                with _lock:
                    _status["connected"] = True
                    _status["subscribed"] = list(_SYMBOLS)
                    _status["error"] = None
                logger.info("alpaca IEX stream connected: %s", _SYMBOLS)
                backoff = 5
                async for raw in ws:
                    with _lock:
                        _status["last_message_at"] = datetime.now(timezone.utc).isoformat()
                    for msg in json.loads(raw):
                        kind = msg.get("T")
                        symbol = msg.get("S")
                        if kind == "t" and symbol in _SYMBOLS:
                            try:
                                ts = pd.Timestamp(msg["t"])
                                if ts.tzinfo is None:
                                    ts = ts.tz_localize("UTC")
                                _record_trade(symbol, float(msg["p"]), float(msg.get("s") or 0), ts)
                            except (KeyError, TypeError, ValueError):
                                continue
                        elif kind in ("b", "u") and symbol in _SYMBOLS:
                            _record_bar(symbol, msg)
        except asyncio.CancelledError:
            with _lock:
                _status["connected"] = False
            raise
        except Exception as exc:  # noqa: BLE001 - reconnect loop
            with _lock:
                _status["connected"] = False
                _status["error"] = str(exc)[:200]
            logger.warning("alpaca stream disconnected (%s); retry in %ss", exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)
