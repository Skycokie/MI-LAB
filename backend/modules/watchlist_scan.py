"""
Scan a watchlist for the latest institutional absorption signals.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from modules import absorption, disk_cache

_CACHE_TTL_SEC = 300


def _scan_one(
    display: str,
    interval: str,
    window: int,
    volume_mult: float,
    limit: int,
    force: bool,
) -> dict[str, Any]:
    cache_key = f"watchlist_scan:{display}:{interval}:{window}:{volume_mult}:{limit}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    result = absorption.get_absorption_signals(
        display,
        interval=interval,
        window=window,
        volume_mult=volume_mult,
        limit=limit,
        force=force,
    )
    payload = {
        "symbol": display.upper().strip(),
        "yahoo_symbol": result.get("yahoo_symbol"),
        "proxy_note": result.get("proxy_note"),
        "interval": interval,
        "estimated": True,
        "signal_count": result.get("signal_count", 0),
        "latest": result["signals"][-1] if result.get("signals") else None,
        "signals": result.get("signals") or [],
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload


def scan_watchlist(
    symbols: list[str],
    interval: str = "15m",
    window: int = 20,
    volume_mult: float = 1.8,
    limit_per: int = 5,
    force: bool = False,
) -> dict[str, Any]:
    """
    Run absorption detection per symbol and return a flat feed + per-symbol summary.

    Uses 15m by default (faster / fewer candles than 5m for a full watchlist scan).
    """
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
    if len(cleaned) > 25:
        raise ValueError("Max 25 symbols per scan.")

    limit_per = max(1, min(int(limit_per), 20))
    per_symbol: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    # Cap concurrency — each scan hits Yahoo 1m history.
    workers = min(4, len(cleaned))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                _scan_one, s, interval, window, volume_mult, limit_per, force
            ): s
            for s in cleaned
        }
        for fut in as_completed(futures):
            sym = futures[fut]
            try:
                per_symbol.append(fut.result())
            except Exception as exc:
                errors.append({"symbol": sym, "error": str(exc)})

    order = {s: i for i, s in enumerate(cleaned)}
    per_symbol.sort(key=lambda r: order.get(r["symbol"], 999))

    feed: list[dict[str, Any]] = []
    for row in per_symbol:
        for sig in row.get("signals") or []:
            feed.append(
                {
                    "symbol": row["symbol"],
                    "yahoo_symbol": row.get("yahoo_symbol"),
                    **sig,
                }
            )

    feed.sort(key=lambda r: r.get("time") or 0, reverse=True)

    return {
        "interval": interval,
        "window": window,
        "volume_mult": volume_mult,
        "estimated": True,
        "scanned": len(per_symbol),
        "per_symbol": per_symbol,
        "signals": feed,
        "errors": errors,
    }
