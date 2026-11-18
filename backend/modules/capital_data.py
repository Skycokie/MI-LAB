"""
Capital.com CFD market data (read-only).

Uses the Capital.com public API *market data* endpoints only — session,
market info and historical prices. No trading endpoints are touched.

Why: Capital CFDs quote live during European hours (indices, gold, oil,
FX), where Yahoo is delayed ~15 min and Alpaca ETFs are asleep. Prices
are broker CFD quotes (bid/ask); SMC works on the mid price.

Auth: POST /api/v1/session with X-CAP-API-KEY + identifier (account
email) + API-key password. Sessions live ~10 minutes; we re-authenticate
transparently and retry once on HTTP 401.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import pandas as pd
import requests

logger = logging.getLogger(__name__)

_TIMEOUT = 15
_SESSION_TTL_SEC = 9 * 60  # Capital sessions expire after ~10 min idle.

# Lab display symbol -> Capital.com epic.
EPIC_MAP: dict[str, str] = {
    "US100": "US100",
    "NAS100": "US100",
    "USTECH": "US100",
    "USA500": "US500",
    "US500": "US500",
    "SPX500": "US500",
    "US30": "US30",
    "DJ30": "US30",
    "WALLSTREET": "US30",
    "GER40": "DE40",
    "DE40": "DE40",
    "DAX40": "DE40",
    "DAX": "DE40",
    "UK100": "UK100",
    "FTSE100": "UK100",
    "FRA40": "FR40",
    "CAC40": "FR40",
    "GOLD": "GOLD",
    "XAUUSD": "GOLD",
    "OIL": "OIL_CRUDE",
    "USOIL": "OIL_CRUDE",
    "BRENT": "OIL_BRENT",
}

_RESOLUTION: dict[str, str] = {
    "1m": "MINUTE",
    "5m": "MINUTE_5",
    "15m": "MINUTE_15",
    "1h": "HOUR",
}

# Capital allows max=1000 per prices request; plenty for SMC windows.
_MAX_BARS: dict[str, int] = {"1m": 1000, "5m": 1000, "15m": 1000, "1h": 750}


def capital_configured() -> bool:
    return bool(
        os.getenv("CAPITAL_API_KEY", "").strip()
        and os.getenv("CAPITAL_IDENTIFIER", "").strip()
        and os.getenv("CAPITAL_API_PASSWORD", "").strip()
    )


def capital_epic(display: str) -> str | None:
    raw = display.upper().strip()
    if raw in EPIC_MAP:
        return EPIC_MAP[raw]
    # Plain FX pairs (EURUSD, GBPJPY, ...) trade under their own epic.
    compact = raw.replace("/", "").replace("=X", "")
    if len(compact) == 6 and compact.isalpha():
        return compact
    return None


def _base_url() -> str:
    env = os.getenv("CAPITAL_ENV", "demo").strip().lower()
    return (
        "https://api-capital.backend-capital.com"
        if env == "live"
        else "https://demo-api-capital.backend-capital.com"
    )


class _CapitalSession:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._http = requests.Session()
        self._expires_at = 0.0

    def _authenticate(self) -> None:
        resp = self._http.post(
            f"{_base_url()}/api/v1/session",
            json={
                "identifier": os.getenv("CAPITAL_IDENTIFIER", "").strip(),
                "password": os.getenv("CAPITAL_API_PASSWORD", "").strip(),
                "encryptedPassword": False,
            },
            headers={
                "X-CAP-API-KEY": os.getenv("CAPITAL_API_KEY", "").strip(),
                "Content-Type": "application/json",
            },
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Capital session failed: HTTP {resp.status_code} {resp.text[:200]}")
        self._http.headers.update(
            {
                "CST": resp.headers.get("CST", ""),
                "X-SECURITY-TOKEN": resp.headers.get("X-SECURITY-TOKEN", ""),
                "X-CAP-API-KEY": os.getenv("CAPITAL_API_KEY", "").strip(),
            }
        )
        self._expires_at = time.time() + _SESSION_TTL_SEC

    def get(self, path: str, params: dict[str, Any] | None = None) -> requests.Response:
        with self._lock:
            if time.time() >= self._expires_at:
                self._authenticate()
            resp = self._http.get(f"{_base_url()}{path}", params=params, timeout=_TIMEOUT)
            if resp.status_code == 401:  # expired early -> re-auth once
                self._authenticate()
                resp = self._http.get(f"{_base_url()}{path}", params=params, timeout=_TIMEOUT)
            return resp


_SESSION = _CapitalSession()


def _mid(price: dict[str, Any] | None) -> float:
    if not price:
        return float("nan")
    bid = float(price.get("bid") or 0)
    ask = float(price.get("ask") or 0)
    if bid > 0 and ask > 0:
        return (bid + ask) / 2.0
    return bid or ask


def fetch_capital_bars(
    display: str, interval: str
) -> tuple[pd.DataFrame, dict[str, Any]] | None:
    """
    Live CFD OHLCV bars (mid price) for SMC, Yahoo-style capitalized
    columns. Returns None on any failure so callers fall back to the
    previous feed (Alpaca / Yahoo).
    """
    epic = capital_epic(display)
    resolution = _RESOLUTION.get(interval)
    if not epic or not resolution or not capital_configured():
        return None
    try:
        resp = _SESSION.get(
            f"/api/v1/prices/{epic}",
            params={"resolution": resolution, "max": _MAX_BARS.get(interval, 1000)},
        )
        if resp.status_code != 200:
            logger.warning("Capital prices %s -> HTTP %s", epic, resp.status_code)
            return None
        rows = resp.json().get("prices") or []
    except Exception as exc:  # noqa: BLE001 - feed must never break SMC
        logger.warning("Capital fetch failed for %s: %s", epic, exc)
        return None

    records: list[dict[str, Any]] = []
    index: list[pd.Timestamp] = []
    for row in rows:
        try:
            ts = pd.Timestamp(row["snapshotTimeUTC"])
            if ts.tzinfo is None:
                ts = ts.tz_localize("UTC")
            o, h = _mid(row.get("openPrice")), _mid(row.get("highPrice"))
            lo, c = _mid(row.get("lowPrice")), _mid(row.get("closePrice"))
            if not all(pd.notna(v) and v > 0 for v in (o, h, lo, c)):
                continue
            index.append(ts)
            records.append(
                {
                    "Open": o,
                    "High": h,
                    "Low": lo,
                    "Close": c,
                    "Volume": float(row.get("lastTradedVolume") or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    if len(records) < 32:
        return None
    df = pd.DataFrame(records, index=pd.DatetimeIndex(index))
    df = df[~df.index.duplicated(keep="last")].sort_index()
    meta: dict[str, Any] = {
        "epic": epic,
        "note": f"Capital.com CFD live {display.upper().strip()}->{epic} (mid price, read-only)",
    }
    return df, meta


def status() -> dict[str, Any]:
    out: dict[str, Any] = {
        "configured": capital_configured(),
        "env": os.getenv("CAPITAL_ENV", "demo").strip().lower(),
        "session_ok": False,
        "error": None,
    }
    if not out["configured"]:
        out["error"] = "CAPITAL_* not set in backend/.env"
        return out
    try:
        resp = _SESSION.get("/api/v1/session")
        out["session_ok"] = resp.status_code == 200
        if resp.status_code != 200:
            out["error"] = f"HTTP {resp.status_code}"
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)[:200]
    return out
