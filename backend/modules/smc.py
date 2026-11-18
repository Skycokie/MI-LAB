"""
SMC / ICT & Fair Value Gap (FVG) Engine.

Computes on intraday OHLCV (1m / 5m / 15m / 1h):
  - Fair Value Gaps (3-candle ICT BISI / SIBI) with Consequent Encroachment
    (50% CE), ATR displacement filter, partial fill %, mitigation & IFVG check
  - Institutional Order Blocks (last opposite-colored candle before a
    displacement move that creates an FVG or breaks structure)
  - Swing Highs / Swing Lows and Market Structure (BOS & CHoCH / MSS)
  - Liquidity Pools: Buyside (BSL / EQH / PDH) & Sellside (SSL / EQL / PDL)
    plus recent Liquidity Sweeps (wick beyond swing, close back inside)
  - Dealing Range: Premium / Equilibrium (50%) / Discount + OTE (62%–79%)
  - Active ICT Killzone (evaluated in America/New_York, displayed in RO time)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from modules import capital_data, disk_cache, market_data
from modules.volume_profile import fetch_intraday, is_fx_pair, resolve_symbol

_CACHE_TTL_SEC = 30
_RO_TZ = ZoneInfo("Europe/Bucharest")
_NY_TZ = ZoneInfo("America/New_York")

_INTERVAL_PERIOD: dict[str, str] = {
    "1m": "5d",
    "5m": "5d",
    "15m": "10d",
    "1h": "30d",
}


def _to_ro_index(df: pd.DataFrame) -> pd.DatetimeIndex:
    idx = df.index
    if not isinstance(idx, pd.DatetimeIndex):
        idx = pd.to_datetime(idx, utc=True)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    return idx.tz_convert(_RO_TZ)


def _chart_ts(ts_ro: pd.Timestamp) -> int:
    """Unix seconds shifted by RO UTC offset so lightweight-charts shows RO time."""
    off = ts_ro.utcoffset().total_seconds() if ts_ro.utcoffset() else 0.0
    return int(ts_ro.timestamp() + off)


def _killzone_now() -> dict[str, Any]:
    now_utc = datetime.now(timezone.utc)
    now_ny = now_utc.astimezone(_NY_TZ)
    now_ro = now_utc.astimezone(_RO_TZ)
    mins = now_ny.hour * 60 + now_ny.minute

    # ICT Killzones in New York local time (auto-adjusts for DST).
    zones = [
        ("ASIA_KZ", "Asia Killzone", 20 * 60, 24 * 60, "03:00–07:00 RO"),
        ("LONDON_OPEN_KZ", "London Open Killzone", 2 * 60, 5 * 60, "09:00–12:00 RO"),
        ("NY_AM_KZ", "NY AM Open Killzone", 8 * 60 + 30, 11 * 60, "15:30–18:00 RO"),
        ("NY_PM_KZ", "NY PM / London Close", 13 * 60 + 30, 16 * 60, "20:30–23:00 RO"),
    ]
    silver_bullets = [
        ("SB_LONDON", "London Silver Bullet (03:00–04:00 NY)", 3 * 60, 4 * 60),
        ("SB_NY_AM", "NY AM Silver Bullet (10:00–11:00 NY)", 10 * 60, 11 * 60),
        ("SB_NY_PM", "NY PM Silver Bullet (14:00–15:00 NY)", 14 * 60, 15 * 60),
    ]

    active_id = None
    active_label = "În afara Killzone-urilor principale"
    window_ro = None
    for zid, label, start_m, end_m, ro_win in zones:
        if start_m <= mins < end_m:
            active_id = zid
            active_label = label
            window_ro = ro_win
            break

    sb_label = None
    for _sid, label, start_m, end_m in silver_bullets:
        if start_m <= mins < end_m:
            sb_label = label
            break

    return {
        "active": active_id is not None,
        "id": active_id,
        "label": active_label,
        "window_ro": window_ro,
        "silver_bullet": sb_label,
        "ro_now": now_ro.strftime("%H:%M"),
        "ny_now": now_ny.strftime("%H:%M"),
    }


def _compute_atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(closes)
    tr = np.empty(n, dtype=float)
    tr[0] = highs[0] - lows[0]
    if n > 1:
        prev_c = closes[:-1]
        tr[1:] = np.maximum(
            highs[1:] - lows[1:],
            np.maximum(np.abs(highs[1:] - prev_c), np.abs(lows[1:] - prev_c)),
        )
    s = pd.Series(tr)
    atr = s.rolling(period, min_periods=1).mean().to_numpy(dtype=float)
    fallback = float(np.nanmedian(tr[tr > 0])) if np.any(tr > 0) else 1e-4
    return np.where(np.isfinite(atr) & (atr > 0), atr, fallback)


def compute_smc(
    symbol: str,
    interval: str = "5m",
    bars: int = 240,
    min_atr_mult: float = 0.15,
    swing_len: int = 3,
    force: bool = False,
) -> dict[str, Any]:
    interval = interval.strip().lower()
    if interval not in _INTERVAL_PERIOD:
        raise ValueError(f"Unsupported interval '{interval}'. Use 1m, 5m, 15m, or 1h.")

    bars = max(80, min(int(bars), 500))
    swing_len = max(2, min(int(swing_len), 8))
    min_atr_mult = max(0.0, min(float(min_atr_mult), 1.5))

    yahoo_symbol, proxy_note = resolve_symbol(symbol)
    fx = is_fx_pair(symbol)
    dp = 5 if fx else 2

    cache_key = f"smc:v3:{yahoo_symbol}:{interval}:{bars}:{min_atr_mult:.2f}:{swing_len}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    period = _INTERVAL_PERIOD[interval]
    data_source = "yahoo"
    feed_symbol = yahoo_symbol
    # 1) Capital.com CFD (live in EU hours, closest to broker CFD quotes)
    capital_pack = None
    if capital_data.capital_epic(symbol) and capital_data.capital_configured():
        try:
            capital_pack = capital_data.fetch_capital_bars(symbol, interval)
        except Exception:  # noqa: BLE001 - live feed must never break SMC
            capital_pack = None
    if capital_pack is not None:
        raw_df, capital_meta = capital_pack
        data_source = "capital_cfd"
        feed_symbol = str(capital_meta["epic"])
        proxy_note = str(capital_meta["note"])
    # 2) Alpaca IEX ETF proxy (live during US cash hours)
    alpaca_pack = None
    if capital_pack is None and market_data.alpaca_index_proxy(symbol) and market_data.alpaca_configured():
        try:
            alpaca_pack = market_data.fetch_alpaca_index_bars(symbol, yahoo_symbol, interval)
        except Exception:  # noqa: BLE001 - live feed must never break SMC
            alpaca_pack = None
    if alpaca_pack is not None:
        raw_df, alpaca_meta = alpaca_pack
        # "alpaca_iex" only when the WebSocket has actually delivered bars;
        # REST-only Basic bars lag ~15 min, so label them honestly.
        data_source = "alpaca_iex" if alpaca_meta.get("live_stream") else "alpaca_iex_rest"
        feed_symbol = str(alpaca_meta["proxy_symbol"])
        proxy_note = str(alpaca_meta["note"])
    elif capital_pack is None:
        # 3) Yahoo fallback (delayed)
        raw_df, yahoo_symbol, proxy_note = fetch_intraday(symbol, interval, period)
    df = raw_df[["Open", "High", "Low", "Close", "Volume"]].dropna(
        subset=["Open", "High", "Low", "Close"]
    ).copy()
    if len(df) < 30:
        raise ValueError(f"Not enough intraday bars ({len(df)}) for '{symbol}'.")

    ro_idx = _to_ro_index(df)
    df.index = ro_idx

    # Previous Day High / Low (PDH / PDL) in Romanian session days (skip tiny Sunday stubs).
    df_days = pd.Series(ro_idx.date, index=ro_idx)
    day_counts = df_days.value_counts()
    valid_days = sorted(d for d in df_days.unique() if day_counts[d] >= 10)
    pdh: float | None = None
    pdl: float | None = None
    prev_session_date: str | None = None
    if len(valid_days) >= 2:
        prev_d = valid_days[-2]
        prev_slice = df[df_days == prev_d]
        if not prev_slice.empty:
            pdh = round(float(prev_slice["High"].max()), dp)
            pdl = round(float(prev_slice["Low"].min()), dp)
            prev_session_date = str(prev_d)

    # Keep a warm-up tail so swings & FVGs formed right before the visible window are accurate.
    work = df.tail(min(len(df), bars + 80)).copy()
    opens = work["Open"].to_numpy(dtype=float)
    highs = work["High"].to_numpy(dtype=float)
    lows = work["Low"].to_numpy(dtype=float)
    closes = work["Close"].to_numpy(dtype=float)
    ts_list = list(work.index)
    chart_times = [_chart_ts(t) for t in ts_list]
    ro_labels = [t.strftime("%Y-%m-%d %H:%M") for t in ts_list]

    atr_arr = _compute_atr(highs, lows, closes, period=14)
    n = len(work)
    vis_start = max(0, n - bars)
    current_price = round(float(closes[-1]), dp)
    current_atr = round(float(atr_arr[-1]), dp)
    last_chart_time = chart_times[-1]

    # ── 1. Fair Value Gaps (3-candle ICT BISI / SIBI) ────────────────────────
    fvgs: list[dict[str, Any]] = []
    fvg_impulse_indices: dict[int, str] = {}

    for i in range(max(1, vis_start), n - 1):
        atr_i = float(atr_arr[i])
        min_gap = min_atr_mult * atr_i
        body_i = abs(closes[i] - opens[i])
        displaced = body_i >= 1.1 * atr_i

        # Bullish FVG (BISI): candle[i-1].high < candle[i+1].low
        bull_gap = lows[i + 1] - highs[i - 1]
        if bull_gap > 0 and bull_gap >= min_gap:
            bottom = float(highs[i - 1])
            top = float(lows[i + 1])
            ce = 0.5 * (top + bottom)
            size = top - bottom

            status = "OPEN"
            fill_pct = 0.0
            ce_touched = False
            inverted = False
            mitigated_idx: int | None = None
            min_after = top

            for j in range(i + 2, n):
                if lows[j] < min_after:
                    min_after = float(lows[j])
                if min_after <= ce:
                    ce_touched = True
                if lows[j] <= bottom:
                    status = "MITIGATED"
                    fill_pct = 100.0
                    mitigated_idx = j
                    if closes[j] < bottom:
                        inverted = True
                    break
                if min_after < top:
                    status = "PARTIAL"
                    fill_pct = round((top - min_after) / size * 100.0, 1)

            end_idx = mitigated_idx if mitigated_idx is not None else (n - 1)
            fvgs.append(
                {
                    "id": f"FVG-BULL-{chart_times[i]}",
                    "type": "BULLISH",
                    "label": "BISI",
                    "time": chart_times[i - 1],
                    "impulse_time": chart_times[i],
                    "end_time": chart_times[end_idx],
                    "ro_time": ro_labels[i],
                    "mitigated_ro_time": ro_labels[mitigated_idx] if mitigated_idx is not None else None,
                    "top": round(top, dp),
                    "bottom": round(bottom, dp),
                    "ce": round(ce, dp),
                    "size": round(size, dp),
                    "atr_mult": round(size / atr_i, 2) if atr_i > 0 else 0.0,
                    "displaced": bool(displaced),
                    "status": status,
                    "fill_pct": fill_pct,
                    "ce_touched": ce_touched,
                    "inverted": inverted,
                    "distance": round(current_price - top if current_price > top else (bottom - current_price if current_price < bottom else 0.0), dp),
                }
            )
            fvg_impulse_indices[i] = "BULLISH"

        # Bearish FVG (SIBI): candle[i+1].high < candle[i-1].low
        bear_gap = lows[i - 1] - highs[i + 1]
        if bear_gap > 0 and bear_gap >= min_gap:
            top = float(lows[i - 1])
            bottom = float(highs[i + 1])
            ce = 0.5 * (top + bottom)
            size = top - bottom

            status = "OPEN"
            fill_pct = 0.0
            ce_touched = False
            inverted = False
            mitigated_idx = None
            max_after = bottom

            for j in range(i + 2, n):
                if highs[j] > max_after:
                    max_after = float(highs[j])
                if max_after >= ce:
                    ce_touched = True
                if highs[j] >= top:
                    status = "MITIGATED"
                    fill_pct = 100.0
                    mitigated_idx = j
                    if closes[j] > top:
                        inverted = True
                    break
                if max_after > bottom:
                    status = "PARTIAL"
                    fill_pct = round((max_after - bottom) / size * 100.0, 1)

            end_idx = mitigated_idx if mitigated_idx is not None else (n - 1)
            fvgs.append(
                {
                    "id": f"FVG-BEAR-{chart_times[i]}",
                    "type": "BEARISH",
                    "label": "SIBI",
                    "time": chart_times[i - 1],
                    "impulse_time": chart_times[i],
                    "end_time": chart_times[end_idx],
                    "ro_time": ro_labels[i],
                    "mitigated_ro_time": ro_labels[mitigated_idx] if mitigated_idx is not None else None,
                    "top": round(top, dp),
                    "bottom": round(bottom, dp),
                    "ce": round(ce, dp),
                    "size": round(size, dp),
                    "atr_mult": round(size / atr_i, 2) if atr_i > 0 else 0.0,
                    "displaced": bool(displaced),
                    "status": status,
                    "fill_pct": fill_pct,
                    "ce_touched": ce_touched,
                    "inverted": inverted,
                    "distance": round(bottom - current_price if current_price < bottom else (current_price - top if current_price > top else 0.0), dp),
                }
            )
            fvg_impulse_indices[i] = "BEARISH"

    # ── 2. Swing Highs / Lows, BOS / CHoCH & Liquidity Sweeps ───────────────
    swing_highs: list[dict[str, Any]] = []
    swing_lows: list[dict[str, Any]] = []
    L = swing_len

    for k in range(L, n - L):
        win_h = highs[k - L : k + L + 1]
        if highs[k] >= np.max(win_h) and np.sum(win_h == highs[k]) == 1:
            swing_highs.append({"idx": k, "price": float(highs[k]), "broken": False, "swept": False})
        win_l = lows[k - L : k + L + 1]
        if lows[k] <= np.min(win_l) and np.sum(win_l == lows[k]) == 1:
            swing_lows.append({"idx": k, "price": float(lows[k]), "broken": False, "swept": False})

    structure_events: list[dict[str, Any]] = []
    sweeps: list[dict[str, Any]] = []
    sh_ptr = 0
    sl_ptr = 0
    active_sh: dict[str, Any] | None = None
    active_sl: dict[str, Any] | None = None
    trend: str | None = None
    bos_impulse_bars: list[tuple[int, str]] = []

    for b in range(L * 2, n):
        # Register swings whose right-side confirmation completed at bar `b` (pivot at `b - L`).
        while sh_ptr < len(swing_highs) and swing_highs[sh_ptr]["idx"] + L <= b:
            active_sh = swing_highs[sh_ptr]
            sh_ptr += 1
        while sl_ptr < len(swing_lows) and swing_lows[sl_ptr]["idx"] + L <= b:
            active_sl = swing_lows[sl_ptr]
            sl_ptr += 1

        if active_sh and not active_sh["broken"]:
            lvl = active_sh["price"]
            if closes[b] > lvl:
                ev_type = "CHOCH_BULL" if trend == "BEARISH" else "BOS_BULL"
                trend = "BULLISH"
                active_sh["broken"] = True
                bos_impulse_bars.append((b, "BULLISH"))
                if b >= vis_start:
                    structure_events.append(
                        {
                            "type": ev_type,
                            "direction": "BULLISH",
                            "time": chart_times[b],
                            "swing_time": chart_times[active_sh["idx"]],
                            "ro_time": ro_labels[b],
                            "price": round(lvl, dp),
                        }
                    )
            elif highs[b] > lvl and closes[b] < lvl and not active_sh["swept"]:
                active_sh["swept"] = True
                if b >= vis_start:
                    sweeps.append(
                        {
                            "type": "BEARISH_SWEEP",
                            "label": "BSL Sweep",
                            "time": chart_times[b],
                            "ro_time": ro_labels[b],
                            "price": round(lvl, dp),
                            "wick": round(float(highs[b]), dp),
                        }
                    )

        if active_sl and not active_sl["broken"]:
            lvl = active_sl["price"]
            if closes[b] < lvl:
                ev_type = "CHOCH_BEAR" if trend == "BULLISH" else "BOS_BEAR"
                trend = "BEARISH"
                active_sl["broken"] = True
                bos_impulse_bars.append((b, "BEARISH"))
                if b >= vis_start:
                    structure_events.append(
                        {
                            "type": ev_type,
                            "direction": "BEARISH",
                            "time": chart_times[b],
                            "swing_time": chart_times[active_sl["idx"]],
                            "ro_time": ro_labels[b],
                            "price": round(lvl, dp),
                        }
                    )
            elif lows[b] < lvl and closes[b] > lvl and not active_sl["swept"]:
                active_sl["swept"] = True
                if b >= vis_start:
                    sweeps.append(
                        {
                            "type": "BULLISH_SWEEP",
                            "label": "SSL Sweep",
                            "time": chart_times[b],
                            "ro_time": ro_labels[b],
                            "price": round(lvl, dp),
                            "wick": round(float(lows[b]), dp),
                        }
                    )

    # ── 3. Institutional Order Blocks (OB) ──────────────────────────────────
    # Triggered by displacement FVGs or BOS/CHoCH impulses; pick last opposite candle within 6 bars prior.
    ob_candidates: dict[tuple[int, str], None] = {}
    for imp_idx, direction in fvg_impulse_indices.items():
        if abs(closes[imp_idx] - opens[imp_idx]) >= 1.0 * atr_arr[imp_idx]:
            ob_candidates[(imp_idx, direction)] = None
    for imp_idx, direction in bos_impulse_bars:
        if imp_idx >= vis_start:
            ob_candidates[(imp_idx, direction)] = None

    seen_ob_bars: set[tuple[int, str]] = set()
    order_blocks: list[dict[str, Any]] = []

    for imp_idx, direction in sorted(ob_candidates.keys()):
        ob_idx: int | None = None
        for back in range(1, 7):
            cand = imp_idx - back
            if cand < vis_start:
                break
            if direction == "BULLISH" and closes[cand] < opens[cand]:
                ob_idx = cand
                break
            if direction == "BEARISH" and closes[cand] > opens[cand]:
                ob_idx = cand
                break
        if ob_idx is None or (ob_idx, direction) in seen_ob_bars:
            continue
        seen_ob_bars.add((ob_idx, direction))

        top = float(highs[ob_idx])
        bottom = float(lows[ob_idx])
        if top - bottom <= 0 or (top - bottom) > 3.5 * atr_arr[ob_idx]:
            continue
        ce = 0.5 * (top + bottom)

        status = "OPEN"
        mitigated_idx = None
        for j in range(imp_idx + 1, n):
            if direction == "BULLISH":
                if closes[j] < bottom:
                    status = "MITIGATED"
                    mitigated_idx = j
                    break
                if lows[j] <= top:
                    status = "TESTED"
            else:
                if closes[j] > top:
                    status = "MITIGATED"
                    mitigated_idx = j
                    break
                if highs[j] >= bottom:
                    status = "TESTED"

        if status != "MITIGATED":
            order_blocks.append(
                {
                    "id": f"OB-{direction[:4]}-{chart_times[ob_idx]}",
                    "type": direction,
                    "time": chart_times[ob_idx],
                    "end_time": last_chart_time,
                    "ro_time": ro_labels[ob_idx],
                    "top": round(top, dp),
                    "bottom": round(bottom, dp),
                    "ce": round(ce, dp),
                    "size": round(top - bottom, dp),
                    "status": status,
                }
            )
        elif mitigated_idx is not None:
            # Keep mitigated OBs out of active list to prevent chart clutter.
            pass

    # Keep the 6 most recent active OBs.
    order_blocks = order_blocks[-6:]

    # ── 4. Resting Liquidity Pools (BSL / SSL + EQH / EQL + PDH / PDL) ──────
    tol = 0.2 * float(atr_arr[-1])
    unbroken_highs = [
        s for s in swing_highs if s["idx"] >= vis_start and float(np.max(highs[s["idx"] + 1 :])) <= s["price"]
    ]
    unbroken_lows = [
        s for s in swing_lows if s["idx"] >= vis_start and float(np.min(lows[s["idx"] + 1 :])) >= s["price"]
    ]

    liquidity_bsl: list[dict[str, Any]] = []
    used_h: set[int] = set()
    for i_s, sh in enumerate(unbroken_highs):
        if i_s in used_h:
            continue
        cluster = [sh]
        for j_s in range(i_s + 1, len(unbroken_highs)):
            if j_s not in used_h and abs(unbroken_highs[j_s]["price"] - sh["price"]) <= tol:
                cluster.append(unbroken_highs[j_s])
                used_h.add(j_s)
        lvl = float(max(c["price"] for c in cluster))
        if lvl >= current_price:
            liquidity_bsl.append(
                {
                    "side": "BSL",
                    "kind": "EQH" if len(cluster) >= 2 else "SWING_HIGH",
                    "touches": len(cluster),
                    "price": round(lvl, dp),
                    "time": chart_times[cluster[-1]["idx"]],
                    "ro_time": ro_labels[cluster[-1]["idx"]],
                    "distance": round(lvl - current_price, dp),
                }
            )
    if pdh is not None and pdh > current_price:
        liquidity_bsl.append(
            {
                "side": "BSL",
                "kind": "PDH",
                "touches": 1,
                "price": pdh,
                "time": chart_times[vis_start],
                "ro_time": prev_session_date or "",
                "distance": round(pdh - current_price, dp),
            }
        )
    liquidity_bsl.sort(key=lambda x: x["distance"])

    liquidity_ssl: list[dict[str, Any]] = []
    used_l: set[int] = set()
    for i_s, sl in enumerate(unbroken_lows):
        if i_s in used_l:
            continue
        cluster = [sl]
        for j_s in range(i_s + 1, len(unbroken_lows)):
            if j_s not in used_l and abs(unbroken_lows[j_s]["price"] - sl["price"]) <= tol:
                cluster.append(unbroken_lows[j_s])
                used_l.add(j_s)
        lvl = float(min(c["price"] for c in cluster))
        if lvl <= current_price:
            liquidity_ssl.append(
                {
                    "side": "SSL",
                    "kind": "EQL" if len(cluster) >= 2 else "SWING_LOW",
                    "touches": len(cluster),
                    "price": round(lvl, dp),
                    "time": chart_times[cluster[-1]["idx"]],
                    "ro_time": ro_labels[cluster[-1]["idx"]],
                    "distance": round(current_price - lvl, dp),
                }
            )
    if pdl is not None and pdl < current_price:
        liquidity_ssl.append(
            {
                "side": "SSL",
                "kind": "PDL",
                "touches": 1,
                "price": pdl,
                "time": chart_times[vis_start],
                "ro_time": prev_session_date or "",
                "distance": round(current_price - pdl, dp),
            }
        )
    liquidity_ssl.sort(key=lambda x: x["distance"])

    # ── 5. Dealing Range (Premium / Equilibrium 50% / Discount + OTE) ───────
    vis_highs = highs[vis_start:]
    vis_lows = lows[vis_start:]
    # Use recent structural window (~last 100 visible bars) for actionable intraday dealing range.
    dr_slice_h = vis_highs[-min(120, len(vis_highs)) :]
    dr_slice_l = vis_lows[-min(120, len(vis_lows)) :]
    range_high = float(np.max(dr_slice_h))
    range_low = float(np.min(dr_slice_l))
    span = max(range_high - range_low, 1e-9)
    equilibrium = 0.5 * (range_high + range_low)
    pos_pct = round((current_price - range_low) / span * 100.0, 1)
    zone_label = "PREMIUM" if current_price >= equilibrium else "DISCOUNT"

    resolved_trend = trend or ("BEARISH" if closes[-1] < opens[vis_start] else "BULLISH")
    if resolved_trend == "BEARISH":
        # Retracement upward into Premium: 61.8% – 78.6% of the drop from range_high to range_low.
        ote_low = range_low + 0.618 * span
        ote_high = range_low + 0.786 * span
        ote_sweet = range_low + 0.705 * span
    else:
        # Retracement downward into Discount: 61.8% – 78.6% pullback from range_high.
        ote_high = range_high - 0.618 * span
        ote_low = range_high - 0.786 * span
        ote_sweet = range_high - 0.705 * span

    dealing_range = {
        "range_high": round(range_high, dp),
        "range_low": round(range_low, dp),
        "equilibrium": round(equilibrium, dp),
        "position_pct": pos_pct,
        "zone": zone_label,
        "ote_direction": resolved_trend,
        "ote_low": round(ote_low, dp),
        "ote_high": round(ote_high, dp),
        "ote_sweet": round(ote_sweet, dp),
        "pdh": pdh,
        "pdl": pdl,
    }

    # Visible candles for the frontend chart.
    candles = [
        {
            "time": chart_times[idx],
            "ro_time": ro_labels[idx],
            "open": round(float(opens[idx]), dp),
            "high": round(float(highs[idx]), dp),
            "low": round(float(lows[idx]), dp),
            "close": round(float(closes[idx]), dp),
        }
        for idx in range(vis_start, n)
    ]

    active_fvgs = [f for f in fvgs if f["status"] in ("OPEN", "PARTIAL")]
    above_bear_fvgs = sorted(
        [f for f in active_fvgs if f["type"] == "BEARISH" and f["top"] >= current_price],
        key=lambda f: max(0.0, f["bottom"] - current_price),
    )
    below_bull_fvgs = sorted(
        [f for f in active_fvgs if f["type"] == "BULLISH" and f["bottom"] <= current_price],
        key=lambda f: max(0.0, current_price - f["top"]),
    )

    payload: dict[str, Any] = {
        "symbol": symbol.upper().strip(),
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "data_source": data_source,
        "feed_symbol": feed_symbol,
        "last_bar_time_ro": ro_labels[-1] if ro_labels else None,
        "interval": interval,
        "timezone": "Europe/Bucharest",
        "current_price": current_price,
        "atr": current_atr,
        "min_atr_mult": min_atr_mult,
        "structure_trend": resolved_trend,
        "last_structure_event": structure_events[-1] if structure_events else None,
        "killzone": _killzone_now(),
        "dealing_range": dealing_range,
        "summary": {
            "open_bull_fvg_count": sum(1 for f in active_fvgs if f["type"] == "BULLISH"),
            "open_bear_fvg_count": sum(1 for f in active_fvgs if f["type"] == "BEARISH"),
            "mitigated_fvg_count": sum(1 for f in fvgs if f["status"] == "MITIGATED"),
            "active_ob_count": len(order_blocks),
            "nearest_bear_fvg": above_bear_fvgs[0] if above_bear_fvgs else None,
            "nearest_bull_fvg": below_bull_fvgs[0] if below_bull_fvgs else None,
            "nearest_bsl": liquidity_bsl[0] if liquidity_bsl else None,
            "nearest_ssl": liquidity_ssl[0] if liquidity_ssl else None,
        },
        "fvgs": fvgs,
        "order_blocks": order_blocks,
        "structure_events": structure_events[-16:],
        "sweeps": sweeps[-12:],
        "liquidity": {
            "bsl": liquidity_bsl[:6],
            "ssl": liquidity_ssl[:6],
        },
        "candles": candles,
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
