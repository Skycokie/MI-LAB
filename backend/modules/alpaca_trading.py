"""
Alpaca Paper trading account + positions risk check (read-only).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

from modules import market_data

logger = logging.getLogger(__name__)

_PAPER_BASE = "https://paper-api.alpaca.markets"
_HTTP_TIMEOUT = 12
_STOP_ORDER_TYPES = {"stop", "stop_limit", "trailing_stop"}


def _headers() -> dict[str, str] | None:
    key = os.getenv("ALPACA_API_KEY_ID", "").strip()
    secret = os.getenv("ALPACA_API_SECRET_KEY", "").strip()
    if not key or not secret:
        return None
    return {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
    }


def get_risk_snapshot() -> dict[str, Any]:
    """
    Margin usage + open positions missing protective stop orders.
    """
    if not market_data.alpaca_configured():
        return {
            "available": False,
            "reason": "ALPACA_NOT_CONFIGURED",
            "message": "Setează ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY pentru risk check.",
        }

    headers = _headers()
    assert headers is not None

    try:
        acc_resp = requests.get(
            f"{_PAPER_BASE}/v2/account", headers=headers, timeout=_HTTP_TIMEOUT
        )
        pos_resp = requests.get(
            f"{_PAPER_BASE}/v2/positions", headers=headers, timeout=_HTTP_TIMEOUT
        )
        ord_resp = requests.get(
            f"{_PAPER_BASE}/v2/orders",
            headers=headers,
            params={"status": "open", "limit": 500},
            timeout=_HTTP_TIMEOUT,
        )
    except Exception as exc:
        logger.warning("alpaca risk fetch failed: %s", exc)
        return {
            "available": False,
            "reason": "ALPACA_REQUEST_FAILED",
            "message": str(exc),
        }

    if acc_resp.status_code != 200:
        return {
            "available": False,
            "reason": "ALPACA_ACCOUNT_ERROR",
            "message": f"HTTP {acc_resp.status_code}: {acc_resp.text[:200]}",
        }

    account = acc_resp.json()
    positions = pos_resp.json() if pos_resp.status_code == 200 else []
    orders = ord_resp.json() if ord_resp.status_code == 200 else []
    if not isinstance(positions, list):
        positions = []
    if not isinstance(orders, list):
        orders = []

    equity = float(account.get("equity") or 0)
    last_equity = float(account.get("last_equity") or equity or 1)
    buying_power = float(account.get("buying_power") or 0)
    cash = float(account.get("cash") or 0)
    multiplier = float(account.get("multiplier") or 1)
    long_mkt = float(account.get("long_market_value") or 0)
    short_mkt = float(account.get("short_market_value") or 0)
    # Rough margin used: exposure vs equity
    exposure = abs(long_mkt) + abs(short_mkt)
    margin_used_pct = (exposure / equity * 100.0) if equity > 0 else 0.0
    day_pl_pct = ((equity / last_equity) - 1.0) * 100.0 if last_equity else 0.0

    symbols_with_stop: set[str] = set()
    for o in orders:
        otype = str(o.get("type") or "").lower()
        if otype in _STOP_ORDER_TYPES or o.get("stop_price") is not None:
            sym = str(o.get("symbol") or "").upper()
            if sym:
                symbols_with_stop.add(sym)

    positions_out: list[dict[str, Any]] = []
    without_sl: list[dict[str, Any]] = []
    for p in positions:
        sym = str(p.get("symbol") or "").upper()
        qty = float(p.get("qty") or 0)
        entry = {
            "symbol": sym,
            "qty": qty,
            "side": p.get("side"),
            "market_value": float(p.get("market_value") or 0),
            "unrealized_pl": float(p.get("unrealized_pl") or 0),
            "unrealized_plpc": float(p.get("unrealized_plpc") or 0) * 100.0,
            "avg_entry_price": float(p.get("avg_entry_price") or 0),
            "current_price": float(p.get("current_price") or 0),
            "has_stop_loss": sym in symbols_with_stop,
        }
        positions_out.append(entry)
        if not entry["has_stop_loss"]:
            without_sl.append(entry)

    return {
        "available": True,
        "paper": True,
        "account": {
            "equity": round(equity, 2),
            "cash": round(cash, 2),
            "buying_power": round(buying_power, 2),
            "multiplier": multiplier,
            "long_market_value": round(long_mkt, 2),
            "short_market_value": round(short_mkt, 2),
            "margin_used_pct": round(margin_used_pct, 2),
            "day_pl_pct": round(day_pl_pct, 3),
            "status": account.get("status"),
            "pattern_day_trader": account.get("pattern_day_trader"),
        },
        "positions": positions_out,
        "positions_without_stop": without_sl,
        "positions_without_stop_count": len(without_sl),
        "open_orders": len(orders),
    }
