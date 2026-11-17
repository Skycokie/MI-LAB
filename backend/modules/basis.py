"""
XTB price calibration ("basis").

XTB has no data API (xAPI was closed on 2025-03-14), and our feeds are not the
CFD price: gold / indices / oil come from futures (GC=F, NQ=F, ...) which sit a
few points away from the broker's spot-like CFD quote.

The user enters the XTB price at the time of the last app bar; we store the
additive offset (xtb - app) per Yahoo symbol and shift every price field in
API responses so VP / VWAP / levels line up with the XTB chart.
Offsets drift (roll, carry), so each one keeps a timestamp and the UI flags
stale ones.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from modules import market_data
from modules.volume_profile import resolve_symbol

_FILE = Path(__file__).resolve().parent.parent / "data" / "basis.json"
_LOCK = threading.Lock()
_RO = ZoneInfo("Europe/Bucharest")

# Numeric fields that are prices in VP / footprint / absorption / quotes /
# forecast payloads. Volumes, deltas, tick sizes and timestamps are untouched.
_PRICE_KEYS = frozenset(
    {
        "open",
        "high",
        "low",
        "close",
        "poc",
        "vah",
        "val",
        "vwap",
        "current_price",
        "price",
        "prev_close",
        # SMC / ICT / FVG levels
        "top",
        "bottom",
        "ce",
        "equilibrium",
        "range_high",
        "range_low",
        "ote_low",
        "ote_high",
        "ote_sweet",
        "pdh",
        "pdl",
    }
)


def _key(display: str) -> str:
    yahoo, _ = resolve_symbol(display)
    return yahoo


def _load() -> dict[str, Any]:
    try:
        return json.loads(_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _save(data: dict[str, Any]) -> None:
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def list_all() -> list[dict[str, Any]]:
    with _LOCK:
        data = _load()
    now = time.time()
    rows = []
    for yahoo, row in data.items():
        rows.append(
            {
                "yahoo_symbol": yahoo,
                "label": row.get("label"),
                "offset": row.get("offset", 0.0),
                "app_price": row.get("app_price"),
                "xtb_price": row.get("xtb_price"),
                "bar_time": row.get("bar_time"),
                "updated_at": row.get("updated_at"),
                "age_hours": round((now - row.get("updated_at", now)) / 3600, 1),
            }
        )
    rows.sort(key=lambda r: r["label"] or r["yahoo_symbol"])
    return rows


def get_offset(display: str) -> float:
    with _LOCK:
        row = _load().get(_key(display))
    return float(row["offset"]) if row else 0.0


def read_app_price(display: str) -> dict[str, Any]:
    """Last raw (uncalibrated) 5m bar so the user can compare with XTB."""
    display = display.upper().strip()
    yahoo, note = resolve_symbol(display)
    df, source = market_data.fetch_history(display, yahoo, "5m", 120)
    if df is None or df.empty:
        raise ValueError(f"No recent bars for '{display}'.")
    last = df.iloc[-1]
    ts = df.index[-1]
    try:
        local = ts.tz_convert(_RO) if ts.tzinfo else ts.tz_localize("UTC").tz_convert(_RO)
        bar_time = local.strftime("%Y-%m-%d %H:%M")
    except Exception:  # noqa: BLE001
        bar_time = str(ts)
    return {
        "symbol": display,
        "yahoo_symbol": yahoo,
        "proxy_note": note,
        "source": source,
        "bar_time": bar_time,
        "bar_tz": "Europe/Bucharest",
        # Yahoo floats are float32-ish; trim the noise (FX needs 5 decimals).
        "app_price": round(float(last["close"]), 3 if float(last["close"]) >= 100 else 5),
        "current_offset": get_offset(display),
    }


def set_from_xtb(display: str, xtb_price: float) -> dict[str, Any]:
    info = read_app_price(display)
    offset = round(float(xtb_price) - info["app_price"], 5)
    with _LOCK:
        data = _load()
        data[info["yahoo_symbol"]] = {
            "label": info["symbol"],
            "offset": offset,
            "app_price": info["app_price"],
            "xtb_price": float(xtb_price),
            "bar_time": info["bar_time"],
            "updated_at": time.time(),
        }
        _save(data)
    return {**info, "xtb_price": float(xtb_price), "offset": offset}


def clear(display: str) -> bool:
    yahoo = _key(display)
    with _LOCK:
        data = _load()
        existed = data.pop(yahoo, None) is not None
        if existed:
            _save(data)
    return existed


def _shift(obj: Any, offset: float) -> Any:
    """Return a copy of obj with price fields shifted (never mutates input)."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k in _PRICE_KEYS and isinstance(v, (int, float)) and not isinstance(v, bool):
                out[k] = round(v + offset, 6)
            else:
                out[k] = _shift(v, offset)
        return out
    if isinstance(obj, list):
        return [_shift(v, offset) for v in obj]
    return obj


def apply(display: str, payload: Any) -> Any:
    """Shift prices in payload by the stored offset for this symbol."""
    off = get_offset(display)
    if not off:
        return payload
    shifted = _shift(payload, off)
    if isinstance(shifted, dict):
        shifted["basis_offset"] = off
    return shifted


def apply_quote_row(row: dict[str, Any]) -> dict[str, Any]:
    """Quotes: shift price + prev_close, keep absolute change, redo change %."""
    off = get_offset(row.get("symbol") or "")
    if not off:
        return row
    out = dict(row)
    out["price"] = round(row["price"] + off, 6)
    out["prev_close"] = round(row["prev_close"] + off, 6)
    out["change_pct"] = (
        round(row["change"] / out["prev_close"] * 100.0, 2) if out["prev_close"] else 0.0
    )
    out["basis_offset"] = off
    return out
