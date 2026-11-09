"""
Per-ticker news.

Providers (auto = first that returns items):
  1. Financial Datasets  (https://api.financialdatasets.ai/news, needs
     FINANCIAL_DATASETS_API_KEY; same data the financial-datasets MCP uses)
  2. Alpaca News         (reuses ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY)

CFD labels are mapped to something that actually has news: stock CFDs drop
the ".US" suffix, crypto uses "BTC/USD" style, and indices / gold / oil fall
back to a liquid ETF proxy (US100 -> QQQ, GOLD -> GLD, ...).
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import requests

from modules import disk_cache, market_data

logger = logging.getLogger(__name__)

_FD_BASE = "https://api.financialdatasets.ai"
_ALPACA_DATA = "https://data.alpaca.markets"
_HTTP_TIMEOUT = 12
_CACHE_TTL = 120.0

# Index / commodity / FX CFDs have no company news -> use an ETF proxy.
_PROXIES: dict[str, str] = {
    "US100": "QQQ",
    "NAS100": "QQQ",
    "NQ": "QQQ",
    "USA500": "SPY",
    "US500": "SPY",
    "SPX500": "SPY",
    "ES": "SPY",
    "US30": "DIA",
    "YM": "DIA",
    "GER40": "EWG",
    "DE40": "EWG",
    "UK100": "EWU",
    "FRA40": "EWQ",
    "EU50": "FEZ",
    "GOLD": "GLD",
    "XAUUSD": "GLD",
    "SILVER": "SLV",
    "XAGUSD": "SLV",
    "OIL": "USO",
    "BRENT": "BNO",
    "EURUSD": "FXE",
    "GBPUSD": "FXB",
    "USDJPY": "FXY",
    "VIX": "VIXY",
    "US10Y": "TLT",
}

_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}$")


def fd_configured() -> bool:
    return bool(os.getenv("FINANCIAL_DATASETS_API_KEY", "").strip())


def status() -> dict[str, Any]:
    return {
        "financial_datasets": fd_configured(),
        "alpaca": market_data.alpaca_configured(),
    }


def resolve_news_symbol(display: str) -> tuple[str, str | None, str]:
    """Return (symbol, proxy_note, kind) where kind is stock|crypto."""
    raw = display.upper().strip()
    if raw in _PROXIES:
        proxy = _PROXIES[raw]
        return proxy, f"{raw} nu are știri proprii · afișez știri pentru {proxy}", "stock"

    if market_data.is_crypto_symbol(raw):
        base = re.split(r"[.\-/=]", raw)[0]
        for quote in ("USDT", "USD"):
            if base.endswith(quote) and len(base) > len(quote):
                base = base[: -len(quote)]
                break
        return f"{base}/USD", None, "crypto"

    # Broker venue suffix: NVDA.US -> NVDA. Non-US suffixes (SIE.DE) have no
    # coverage; they fail the ticker regex below and return "unsupported".
    if raw.endswith(".US"):
        raw = raw[:-3]
    return raw, None, "stock"


def _parse_dt(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        return text


def _fetch_financial_datasets(symbol: str, limit: int) -> list[dict[str, Any]]:
    key = os.getenv("FINANCIAL_DATASETS_API_KEY", "").strip()
    resp = requests.get(
        f"{_FD_BASE}/news",
        headers={"X-API-KEY": key},
        # The API rejects larger limits with 400.
        params={"ticker": symbol, "limit": min(limit, 10)},
        timeout=_HTTP_TIMEOUT,
    )
    if resp.status_code in (401, 403):
        raise PermissionError("Financial Datasets: cheie API invalidă sau fără acces")
    if resp.status_code == 402:
        raise PermissionError("Financial Datasets: plan insuficient / credite epuizate")
    resp.raise_for_status()
    items: list[dict[str, Any]] = []
    for row in resp.json().get("news") or []:
        items.append(
            {
                "title": str(row.get("title") or "").strip(),
                "summary": None,
                "source": row.get("source"),
                "author": row.get("author"),
                "published_at": _parse_dt(row.get("date")),
                "url": row.get("url"),
                "tickers": [row["ticker"]] if row.get("ticker") else [symbol],
                "sentiment": row.get("sentiment"),
                "provider": "financial-datasets",
            }
        )
    return items


def _fetch_alpaca(symbol: str, limit: int) -> list[dict[str, Any]]:
    resp = requests.get(
        f"{_ALPACA_DATA}/v1beta1/news",
        headers={
            "APCA-API-KEY-ID": os.getenv("ALPACA_API_KEY_ID", "").strip(),
            "APCA-API-SECRET-KEY": os.getenv("ALPACA_API_SECRET_KEY", "").strip(),
        },
        params={"symbols": symbol, "limit": limit, "sort": "desc"},
        timeout=_HTTP_TIMEOUT,
    )
    resp.raise_for_status()
    items: list[dict[str, Any]] = []
    for row in resp.json().get("news") or []:
        summary = str(row.get("summary") or "").strip()
        items.append(
            {
                "title": str(row.get("headline") or "").strip(),
                "summary": summary or None,
                "source": row.get("source"),
                "author": row.get("author"),
                "published_at": _parse_dt(row.get("created_at")),
                "url": row.get("url"),
                "tickers": list(row.get("symbols") or [symbol]),
                "sentiment": None,
                "provider": "alpaca",
            }
        )
    return items


def get_news(
    display: str,
    limit: int = 20,
    source: str = "auto",
    force: bool = False,
) -> dict[str, Any]:
    display = display.upper().strip()
    if not display:
        raise ValueError("ticker is required")
    source = source.lower()
    if source not in ("auto", "financial-datasets", "alpaca"):
        raise ValueError("source must be auto, financial-datasets or alpaca")

    symbol, proxy_note, kind = resolve_news_symbol(display)
    if kind == "stock" and not _TICKER_RE.match(symbol):
        return {
            "available": False,
            "ticker": display,
            "symbol": symbol,
            "message": (
                f"Nu există acoperire de știri pentru {display} "
                "(doar acțiuni/ETF US, crypto și proxy-uri pentru indici/aur/petrol)."
            ),
            "items": [],
        }

    cache_key = f"news|{symbol}|{source}|{limit}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            cached["ticker"] = display
            cached["proxy_note"] = proxy_note
            return cached

    # Financial Datasets covers company tickers only (no crypto pairs).
    order: list[str] = []
    if source in ("auto", "financial-datasets") and kind == "stock" and fd_configured():
        order.append("financial-datasets")
    if source in ("auto", "alpaca") and market_data.alpaca_configured():
        order.append("alpaca")

    if not order:
        return {
            "available": False,
            "ticker": display,
            "symbol": symbol,
            "message": (
                "Niciun furnizor de știri configurat. Setează "
                "FINANCIAL_DATASETS_API_KEY (sau cheile Alpaca) în backend/.env."
            ),
            "items": [],
            "providers": status(),
        }

    items: list[dict[str, Any]] = []
    used: str | None = None
    errors: list[str] = []
    for provider in order:
        try:
            if provider == "financial-datasets":
                items = _fetch_financial_datasets(symbol, limit)
            else:
                items = _fetch_alpaca(symbol, limit)
        except Exception as exc:  # noqa: BLE001 - surface as per-provider error
            logger.warning("news %s via %s: %s", symbol, provider, exc)
            errors.append(f"{provider}: {exc}")
            continue
        items = [i for i in items if i["title"]]
        if items:
            used = provider
            break

    items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    result: dict[str, Any] = {
        "available": True,
        "ticker": display,
        "symbol": symbol,
        "proxy_note": proxy_note,
        "provider": used,
        "count": len(items),
        "items": items[:limit],
        "errors": errors,
        "providers": status(),
        "as_of": datetime.now(timezone.utc).isoformat(),
    }
    # Don't cache provider failures for the full TTL.
    disk_cache.set(cache_key, result, _CACHE_TTL if items else 15.0)
    return result
