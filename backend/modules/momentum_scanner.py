"""
US momentum scanner over a fixed liquid universe (Yahoo Finance, delayed).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yfinance as yf

from modules import disk_cache

_CACHE_TTL_SEC = 120
_UNIVERSE_PATH = Path(__file__).resolve().parent.parent / "data" / "scanner_universe_us.txt"
_MAX_WORKERS = 12


def load_universe() -> list[str]:
    if not _UNIVERSE_PATH.exists():
        return ["SPY", "QQQ", "AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "META"]
    symbols: list[str] = []
    seen: set[str] = set()
    for line in _UNIVERSE_PATH.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        sym = raw.upper()
        if sym in seen:
            continue
        seen.add(sym)
        symbols.append(sym)
    return symbols


def _scan_one(symbol: str) -> dict[str, Any]:
    tk = yf.Ticker(symbol)
    hist = tk.history(period="1mo", auto_adjust=True)
    if hist is None or hist.empty or "Close" not in hist.columns:
        raise ValueError(f"No history for {symbol}")

    closes = hist["Close"].dropna()
    if len(closes) < 2:
        raise ValueError(f"Insufficient closes for {symbol}")

    last = float(closes.iloc[-1])
    prev = float(closes.iloc[-2])
    gap_pct = ((last - prev) / prev * 100.0) if prev else 0.0

    volume_today = 0.0
    avg_volume = 0.0
    rvol = 0.0
    if "Volume" in hist.columns:
        vols = hist["Volume"].dropna().astype(float)
        if not vols.empty:
            volume_today = float(vols.iloc[-1])
            prior = vols.iloc[:-1].tail(20)
            if len(prior) > 0:
                avg_volume = float(prior.mean())
                rvol = (volume_today / avg_volume) if avg_volume > 0 else 0.0

    name: str | None = None
    try:
        info = getattr(tk, "fast_info", None)
        if info is not None:
            name = getattr(info, "short_name", None) or None
    except Exception:
        name = None

    return {
        "symbol": symbol,
        "name": name,
        "price": round(last, 4 if last < 50 else 2),
        "prev_close": round(prev, 4 if prev < 50 else 2),
        "gap_pct": round(gap_pct, 2),
        "volume": int(volume_today),
        "avg_volume": int(avg_volume),
        "rvol": round(rvol, 2),
    }


def scan_momentum(
    min_gap_pct: float = 3.0,
    min_rvol: float = 2.0,
    min_price: float = 5.0,
    max_price: float = 100.0,
    force: bool = False,
) -> dict[str, Any]:
    """
    Scan the liquid US universe for gap + relative-volume momentum.

    Yahoo data is typically delayed ~15 minutes for free endpoints.
    """
    min_gap_pct = max(0.0, float(min_gap_pct))
    min_rvol = max(0.0, float(min_rvol))
    min_price = max(0.0, float(min_price))
    max_price = max(min_price, float(max_price))

    cache_key = (
        f"scanner:momentum:{min_gap_pct}:{min_rvol}:{min_price}:{max_price}"
    )
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict) and "hits" in cached:
            return cached

    universe = load_universe()
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futures = {pool.submit(_scan_one, sym): sym for sym in universe}
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                rows.append(fut.result())
            except Exception as exc:
                errors.append({"symbol": sym, "error": str(exc)})

    hits = [
        r
        for r in rows
        if abs(float(r["gap_pct"])) >= min_gap_pct
        and float(r["rvol"]) >= min_rvol
        and min_price <= float(r["price"]) <= max_price
    ]
    hits.sort(key=lambda r: (abs(float(r["gap_pct"])), float(r["rvol"])), reverse=True)

    payload: dict[str, Any] = {
        "as_of": datetime.now(timezone.utc).isoformat(),
        "delayed": True,
        "source": "yahoo",
        "filters": {
            "min_gap_pct": min_gap_pct,
            "min_rvol": min_rvol,
            "min_price": min_price,
            "max_price": max_price,
        },
        "universe_size": len(universe),
        "scanned": len(rows),
        "hit_count": len(hits),
        "hits": hits,
        "errors": errors,
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
