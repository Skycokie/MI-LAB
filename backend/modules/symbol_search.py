"""
Yahoo Finance symbol search for watchlist autocomplete.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import requests

from modules import disk_cache

_YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search"
_CACHE_TTL_SEC = 300
_USER_AGENT = (
    "Mozilla/5.0 (compatible; MarketInstitutionalLab/1.0; +http://localhost)"
)
_ALLOWED_TYPES = frozenset(
    {"EQUITY", "ETF", "INDEX", "FUTURE", "CURRENCY", "CRYPTOCURRENCY", "MUTUALFUND"}
)


def search_symbols(q: str, limit: int = 8) -> dict[str, Any]:
    """
    Search Yahoo for symbols matching `q`.

    Returns {"query": str, "results": [{symbol, name, exchange, type}, ...]}.
    Queries shorter than 2 characters skip the network and return [].
    """
    query = (q or "").strip()
    n = max(1, min(int(limit), 20))
    if len(query) < 2:
        return {"query": query, "results": []}

    cache_key = f"search:{query.lower()}:{n}"
    cached = disk_cache.get(cache_key)
    if isinstance(cached, dict) and "results" in cached:
        return cached

    url = (
        f"{_YAHOO_SEARCH}?q={quote(query)}"
        f"&quotesCount={n}&newsCount=0&listsCount=0&enableFuzzyQuery=false"
    )
    try:
        res = requests.get(
            url,
            headers={"User-Agent": _USER_AGENT},
            timeout=12,
        )
        res.raise_for_status()
        body = res.json()
    except Exception as exc:
        raise ValueError(f"Yahoo search failed for '{query}': {exc}") from exc

    raw_quotes = body.get("quotes") or []
    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in raw_quotes:
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol or symbol in seen:
            continue
        qtype = str(row.get("quoteType") or row.get("typeDisp") or "").upper()
        if qtype and qtype not in _ALLOWED_TYPES:
            continue
        name = (
            row.get("shortname")
            or row.get("longname")
            or row.get("name")
            or symbol
        )
        exchange = row.get("exchDisp") or row.get("exchange") or ""
        results.append(
            {
                "symbol": symbol,
                "name": str(name),
                "exchange": str(exchange),
                "type": qtype or "EQUITY",
            }
        )
        seen.add(symbol)
        if len(results) >= n:
            break

    payload = {"query": query, "results": results}
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
