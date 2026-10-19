"""
Gamma Exposure (GEX) for US equities / ETFs via yfinance options chains.

Uses Black-Scholes gamma rather than the naive OI * S^2 * IV proxy.
Dealer convention: Call GEX positive, Put GEX negative.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf
from scipy.stats import norm

from modules import disk_cache
from modules.volume_profile import resolve_symbol

# Short TTL so Yahoo is not hammered during dashboard refreshes.
_CACHE_TTL_SEC = 300
_EU_SUFFIXES = (".DE", ".PA", ".FR", ".L", ".AS", ".BR", ".MI", ".MC", ".SW", ".HE")

_DEFAULT_R = 0.05  # risk-free rate assumption


def _to_py_float(value: Any) -> float | None:
    """Convert numpy / pandas scalars to plain Python float; drop NaN/inf."""
    try:
        if value is None or (isinstance(value, float) and math.isnan(value)):
            return None
        f = float(value)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def black_scholes_gamma(
    S: float, K: float, T: float, sigma: float, r: float = _DEFAULT_R
) -> float:
    """Black-Scholes gamma for a European option (same for call and put)."""
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    sqrt_T = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_T)
    return float(norm.pdf(d1) / (S * sigma * sqrt_T))


def _years_to_expiry(expiry_str: str) -> float:
    """Calendar years until option expiration date (YYYY-MM-DD)."""
    exp = datetime.strptime(expiry_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    days = max((exp - now).total_seconds() / 86400.0, 1 / 365.0)
    return days / 365.0


def _contract_gex(
    open_interest: float,
    gamma: float,
    spot: float,
    sign: int,
) -> float:
    """
    Dollar gamma exposure for a 1% move:
        GEX = gamma * OI * contract_multiplier * S^2 * 0.01
    Equity options multiplier = 100.
    """
    return sign * gamma * open_interest * 100.0 * (spot**2) * 0.01


def _gamma_flip_strike(strikes: np.ndarray, total_gex: np.ndarray) -> float | None:
    """
    Strike where cumulative GEX (sorted ascending by strike) crosses zero.
    """
    if len(strikes) < 2:
        return None
    order = np.argsort(strikes)
    s = strikes[order]
    cum = np.cumsum(total_gex[order])
    for i in range(1, len(cum)):
        if cum[i - 1] == 0:
            return float(s[i - 1])
        if cum[i - 1] * cum[i] < 0:
            # Linear interpolation between the two strikes
            w = abs(cum[i - 1]) / (abs(cum[i - 1]) + abs(cum[i]))
            return float(s[i - 1] + w * (s[i] - s[i - 1]))
    return None


def compute_gex(
    ticker: str, expirations: int = 1, force: bool = False
) -> dict[str, Any]:
    """
    Aggregate GEX across the nearest `expirations` option expiry dates.

    Returns spot, per-strike levels (±10% of spot), net GEX, gamma flip,
    call wall (max call GEX strike) and put wall (min put GEX strike).
    """
    display = ticker.upper().strip()
    yahoo_symbol, proxy_note = resolve_symbol(display)
    cache_key = f"gex:{display}:{yahoo_symbol}:{expirations}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    is_european = yahoo_symbol.upper().endswith(_EU_SUFFIXES) or display.endswith(
        _EU_SUFFIXES
    )
    if is_european:
        payload = {
            "available": False,
            "reason": "EUROPEAN_NO_US_OPTIONS",
            "ticker": display,
            "yahoo_symbol": yahoo_symbol,
            "proxy_note": proxy_note,
            "message": (
                "GEX indisponibil pentru piețele europene "
                "(necesită feed Eurex / lanț de opțiuni US)."
            ),
            "suggested_tabs": ["vp", "fp"],
        }
        disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
        return payload

    tk = yf.Ticker(yahoo_symbol)
    # yfinance 1.x exposes expiry dates on `.options` (not `.expirations`).
    all_expiries = list(getattr(tk, "options", None) or [])
    if not all_expiries:
        payload = {
            "available": False,
            "reason": "NO_OPTIONS_CHAIN",
            "ticker": display,
            "yahoo_symbol": yahoo_symbol,
            "proxy_note": proxy_note,
            "message": (
                f"GEX indisponibil: '{display}' ({yahoo_symbol}) nu are lanț de opțiuni "
                "pe Yahoo. Încearcă Volume Profile sau Footprint."
            ),
            "suggested_tabs": ["vp", "fp"],
        }
        disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
        return payload

    n = max(1, min(int(expirations), len(all_expiries)))

    hist = tk.history(period="5d")
    if hist.empty:
        raise ValueError(f"No price history for '{display}' ({yahoo_symbol}).")
    spot = float(hist["Close"].iloc[-1])

    used_volume_fallback = False
    min_iv = 0.01  # discard Yahoo placeholder IVs (~1e-5)

    # Score nearest expiries by usable interest, then keep the best `n`.
    # Yahoo often returns OI=0 on front weeklies; volume is used as fallback.
    scored: list[tuple[float, str, list[dict[str, float]], bool]] = []
    scan_limit = min(len(all_expiries), max(n * 4, 12))

    for expiry in all_expiries[:scan_limit]:
        T = _years_to_expiry(expiry)
        try:
            chain = tk.option_chain(expiry)
        except Exception:
            continue

        expiry_rows: list[dict[str, float]] = []
        expiry_interest = 0.0
        expiry_used_vol = False

        for side, frame, sign in (
            ("call", chain.calls, 1),
            ("put", chain.puts, -1),
        ):
            if frame is None or frame.empty:
                continue
            for col in ("strike", "impliedVolatility"):
                if col not in frame.columns:
                    raise ValueError(f"Missing column '{col}' in {side} chain.")

            has_oi = "openInterest" in frame.columns
            has_vol = "volume" in frame.columns

            for _, row in frame.iterrows():
                strike = _to_py_float(row["strike"])
                iv = _to_py_float(row["impliedVolatility"]) or 0.0
                if strike is None or iv < min_iv:
                    continue

                oi = _to_py_float(row["openInterest"]) if has_oi else None
                vol = _to_py_float(row["volume"]) if has_vol else None
                interest = oi if oi and oi > 0 else (vol if vol and vol > 0 else 0.0)
                if interest <= 0:
                    continue
                if not (oi and oi > 0):
                    expiry_used_vol = True

                gamma = black_scholes_gamma(spot, strike, T, iv)
                gex_val = _contract_gex(interest, gamma, spot, sign)
                expiry_interest += interest
                expiry_rows.append(
                    {
                        "strike": strike,
                        "gex_call": gex_val if sign > 0 else 0.0,
                        "gex_put": gex_val if sign < 0 else 0.0,
                        "total_gex": gex_val,
                    }
                )

        if expiry_rows:
            scored.append((expiry_interest, expiry, expiry_rows, expiry_used_vol))

    if not scored:
        raise ValueError(
            f"No option open interest/volume available for '{display}' "
            "(Yahoo may be returning empty OI for this ticker right now)."
        )

    # Prefer higher interest; keep chronological order in the response.
    scored.sort(key=lambda x: x[0], reverse=True)
    chosen = sorted(scored[:n], key=lambda x: x[1])
    selected = [e for _, e, _, _ in chosen]
    rows: list[dict[str, float]] = []
    for _, _, expiry_rows, used_vol in chosen:
        rows.extend(expiry_rows)
        used_volume_fallback = used_volume_fallback or used_vol

    df = pd.DataFrame(rows)
    grouped = (
        df.groupby("strike", as_index=False)
        .agg({"gex_call": "sum", "gex_put": "sum", "total_gex": "sum"})
        .sort_values("strike")
    )

    lo, hi = spot * 0.9, spot * 1.1
    filtered = grouped[(grouped["strike"] >= lo) & (grouped["strike"] <= hi)].copy()
    if filtered.empty:
        filtered = grouped.copy()

    strikes = filtered["strike"].to_numpy(dtype=float)
    totals = filtered["total_gex"].to_numpy(dtype=float)
    calls = filtered["gex_call"].to_numpy(dtype=float)
    puts = filtered["gex_put"].to_numpy(dtype=float)

    call_wall = float(strikes[int(np.argmax(calls))]) if len(calls) else None
    put_wall = float(strikes[int(np.argmin(puts))]) if len(puts) else None
    gamma_flip = _gamma_flip_strike(strikes, totals)
    net_gex = float(np.nansum(totals))

    levels = []
    for _, r in filtered.iterrows():
        levels.append(
            {
                "strike": round(float(r["strike"]), 2),
                "gex_call": round(float(r["gex_call"]), 2),
                "gex_put": round(float(r["gex_put"]), 2),
                "total_gex": round(float(r["total_gex"]), 2),
            }
        )

    payload: dict[str, Any] = {
        "available": True,
        "ticker": display,
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "spot_price": round(spot, 2),
        "expirations": selected,
        "expiration": selected[0],
        "net_gex": round(net_gex, 2),
        "gamma_flip": round(gamma_flip, 2) if gamma_flip is not None else None,
        "call_wall": round(call_wall, 2) if call_wall is not None else None,
        "put_wall": round(put_wall, 2) if put_wall is not None else None,
        "interest_source": "volume_fallback" if used_volume_fallback else "open_interest",
        "levels": levels,
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
