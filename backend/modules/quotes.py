"""
Batch last-price / day-change quotes for a watchlist of CFD / equity symbols.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import yfinance as yf

from modules import disk_cache
from modules.volume_profile import resolve_symbol

_CACHE_TTL_SEC = 60


def _one_quote(display: str) -> dict[str, Any]:
    yahoo, note = resolve_symbol(display)
    cache_key = f"quotes:{yahoo}"
    cached = disk_cache.get(cache_key)
    if isinstance(cached, dict):
        return {**cached, "symbol": display.upper().strip(), "proxy_note": note}

    tk = yf.Ticker(yahoo)
    hist = tk.history(period="5d", auto_adjust=True)
    if hist is None or hist.empty or "Close" not in hist.columns:
        raise ValueError(f"No quote data for '{display}' ({yahoo}).")

    closes = hist["Close"].dropna()
    if closes.empty:
        raise ValueError(f"Empty closes for '{display}' ({yahoo}).")

    last = float(closes.iloc[-1])
    prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
    change = last - prev
    change_pct = (change / prev * 100.0) if prev else 0.0

    name = None
    try:
        info = getattr(tk, "fast_info", None)
        if info is not None:
            name = getattr(info, "short_name", None) or None
    except Exception:
        name = None

    base = {
        "yahoo_symbol": yahoo,
        "name": name,
        "price": round(last, 4 if last < 50 else 2),
        "prev_close": round(prev, 4 if prev < 50 else 2),
        "change": round(change, 4 if abs(change) < 1 else 2),
        "change_pct": round(change_pct, 2),
        "currency": None,
        "as_of": str(closes.index[-1].date()),
    }
    disk_cache.set(cache_key, base, _CACHE_TTL_SEC)
    return {**base, "symbol": display.upper().strip(), "proxy_note": note}


def get_quotes(symbols: list[str]) -> dict[str, Any]:
    """Fetch quotes for many display symbols (CFD labels ok)."""
    cleaned = []
    seen = set()
    for s in symbols:
        u = s.strip().upper()
        if not u or u in seen:
            continue
        seen.add(u)
        cleaned.append(u)
    if not cleaned:
        raise ValueError("Provide at least one symbol.")
    if len(cleaned) > 40:
        raise ValueError("Max 40 symbols per request.")

    rows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    with ThreadPoolExecutor(max_workers=min(8, len(cleaned))) as pool:
        futures = {pool.submit(_one_quote, s): s for s in cleaned}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                rows.append(fut.result())
            except Exception as exc:
                errors.append({"symbol": sym, "error": str(exc)})

    order = {s: i for i, s in enumerate(cleaned)}
    rows.sort(key=lambda r: order.get(r["symbol"], 999))
    return {
        "count": len(rows),
        "quotes": rows,
        "errors": errors,
    }
