"""
Footprint imbalances (diagonal Ask@P vs Bid@P-1 tick).

Buying imbalance  → aggressive buyers dominate at the higher level.
Selling imbalance → aggressive sellers dominate at the lower level.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from modules import disk_cache, orderflow

_CACHE_TTL_SEC = 180


def calculate_footprint_imbalances(
    tick_data: pd.DataFrame,
    imbalance_ratio: float = 3.0,
    tick_size: float | None = None,
    min_volume: float = 1.0,
) -> pd.DataFrame:
    """
    Compute buying / selling imbalances from tick-level bid/ask flow.

    `tick_data` must contain columns ['price', 'volume', 'side'] with
    side in {'BID', 'ASK'}. Returns a DataFrame indexed by price with
    columns bid, ask, buying_imbalance, selling_imbalance.

    Levels with no trades are reindexed onto a complete tick grid so the
    diagonal comparison never skips empty prices.
    """
    if tick_data is None or tick_data.empty:
        return pd.DataFrame(
            columns=["bid", "ask", "buying_imbalance", "selling_imbalance"]
        )

    required = {"price", "volume", "side"}
    missing = required - set(tick_data.columns)
    if missing:
        raise ValueError(f"tick_data missing columns: {sorted(missing)}")

    working = tick_data.copy()
    working["side"] = working["side"].str.upper()
    bid_vol = (
        working[working["side"] == "BID"].groupby("price")["volume"].sum()
    )
    ask_vol = (
        working[working["side"] == "ASK"].groupby("price")["volume"].sum()
    )
    fp = pd.DataFrame({"bid": bid_vol, "ask": ask_vol}).fillna(0.0)

    if fp.empty:
        return fp.assign(buying_imbalance=False, selling_imbalance=False)

    prices = np.sort(fp.index.to_numpy(dtype=float))
    if tick_size is None:
        diffs = np.diff(prices)
        positive = diffs[diffs > 0]
        tick_size = float(np.min(positive)) if len(positive) else 0.01

    # Complete grid from min to max so empty levels count as zero.
    grid = np.round(
        np.arange(prices[0], prices[-1] + tick_size * 0.5, tick_size),
        decimals=10,
    )
    fp = fp.reindex(grid, fill_value=0.0).sort_index()

    bid = fp["bid"].to_numpy(dtype=float)
    ask = fp["ask"].to_numpy(dtype=float)
    buying = np.zeros(len(fp), dtype=bool)
    selling = np.zeros(len(fp), dtype=bool)

    # Diagonal: ask[i+1] vs bid[i]
    bid_curr = bid[:-1]
    ask_next = ask[1:]

    buy_mask = (bid_curr >= min_volume) & (
        ask_next / np.maximum(bid_curr, 1e-12) >= imbalance_ratio
    )
    sell_mask = (ask_next >= min_volume) & (
        bid_curr / np.maximum(ask_next, 1e-12) >= imbalance_ratio
    )

    buying[1:] = buy_mask
    selling[:-1] = sell_mask

    fp["buying_imbalance"] = buying
    fp["selling_imbalance"] = selling
    return fp


def _levels_to_tick_df(levels: list[dict[str, Any]]) -> pd.DataFrame:
    """Convert [{price, bid, ask}, ...] into the tick_data shape."""
    rows: list[dict[str, Any]] = []
    for lvl in levels:
        price = float(lvl["price"])
        bid = float(lvl.get("bid", 0) or 0)
        ask = float(lvl.get("ask", 0) or 0)
        if bid > 0:
            rows.append({"price": price, "volume": bid, "side": "BID"})
        if ask > 0:
            rows.append({"price": price, "volume": ask, "side": "ASK"})
    if not rows:
        return pd.DataFrame(columns=["price", "volume", "side"])
    return pd.DataFrame(rows)


def _footprint_rows(
    levels: list[dict[str, Any]],
    imbalance_ratio: float,
    tick_size: float,
) -> list[dict[str, Any]]:
    tick_df = _levels_to_tick_df(levels)
    fp = calculate_footprint_imbalances(
        tick_df,
        imbalance_ratio=imbalance_ratio,
        tick_size=tick_size,
        min_volume=1.0,
    )
    # Keep only levels that actually printed volume (drop empty grid cells).
    if not fp.empty:
        fp = fp[(fp["bid"] > 0) | (fp["ask"] > 0)]

    out: list[dict[str, Any]] = []
    for price, row in fp.iterrows():
        out.append(
            {
                "price": round(float(price), 10),
                "bid": round(float(row["bid"]), 2),
                "ask": round(float(row["ask"]), 2),
                "buying_imbalance": bool(row["buying_imbalance"]),
                "selling_imbalance": bool(row["selling_imbalance"]),
            }
        )
    # Highest price first (top of candle).
    out.sort(key=lambda r: r["price"], reverse=True)
    return out


def build_footprint(
    symbol: str,
    interval: str = "15m",
    candles: int = 12,
    imbalance_ratio: float = 3.0,
    tick_size: float | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """
    Build footprint candles with diagonal imbalances and POC per bar.
    """
    n = max(1, min(int(candles), 48))
    cache_key = f"footprint:{symbol.upper()}:{interval}:{n}:{imbalance_ratio}:{tick_size}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    of = orderflow.build_orderflow(
        symbol, interval=interval, tick_size=tick_size
    )
    all_candles = of["candles"]
    selected = all_candles[-n:]
    used_tick = float(of["tick_size"])

    footprint_candles: list[dict[str, Any]] = []
    for candle in selected:
        levels = _footprint_rows(
            candle["levels"],
            imbalance_ratio=imbalance_ratio,
            tick_size=used_tick,
        )
        poc = None
        if levels:
            poc = max(levels, key=lambda r: r["bid"] + r["ask"])["price"]

        buy_count = sum(1 for r in levels if r["buying_imbalance"])
        sell_count = sum(1 for r in levels if r["selling_imbalance"])

        footprint_candles.append(
            {
                "time": int(candle["time"]),
                "open": round(float(candle["open"]), 6),
                "high": round(float(candle["high"]), 6),
                "low": round(float(candle["low"]), 6),
                "close": round(float(candle["close"]), 6),
                "volume": round(float(candle["volume"]), 2),
                "delta": round(float(candle["delta"]), 2),
                "poc": poc,
                "buying_imbalances": buy_count,
                "selling_imbalances": sell_count,
                "levels": levels,
            }
        )

    payload: dict[str, Any] = {
        "symbol": of["symbol"],
        "yahoo_symbol": of["yahoo_symbol"],
        "proxy_note": of["proxy_note"],
        "interval": interval,
        "tick_size": used_tick,
        "imbalance_ratio": imbalance_ratio,
        "estimated": True,
        "candles": footprint_candles,
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
