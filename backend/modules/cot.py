"""
CFTC Commitment of Traders (Legacy Futures Only) via the public Socrata API.

Dataset id: 6dca-aqww (no API key required, updated weekly).
Primary host : https://publicreporting.cftc.gov/resource/6dca-aqww.json
Fallback host: https://data.cftc.gov/resource/6dca-aqww.json

Per currency we filter the CME FX futures contract (by CFTC market code AND
market name, e.g. "EURO FX", "BRITISH POUND", "JAPANESE YEN") and return the
net positions of:
  - Non-Commercials  (large speculators / funds -> "Smart Money")
  - Commercials      (hedgers)
  - Non-reportable   (small traders -> "Retail")
for the most recent N weeks (default 10).
"""

from __future__ import annotations

from typing import Any

import requests

from modules import disk_cache

SOCRATA_HOSTS = (
    "https://publicreporting.cftc.gov/resource/6dca-aqww.json",
    "https://data.cftc.gov/resource/6dca-aqww.json",
)

# currency -> (CFTC contract market code, market-name prefix)
CURRENCY_CONTRACTS: dict[str, tuple[str, str]] = {
    "EUR": ("099741", "EURO FX"),
    "GBP": ("096742", "BRITISH POUND"),
    "JPY": ("097741", "JAPANESE YEN"),
    "CAD": ("090741", "CANADIAN DOLLAR"),
    "AUD": ("232741", "AUSTRALIAN DOLLAR"),
    "CHF": ("092741", "SWISS FRANC"),
    "NZD": ("112741", "NZ DOLLAR"),
    "MXN": ("095741", "MEXICAN PESO"),
}

SUPPORTED = sorted(CURRENCY_CONTRACTS.keys())
DEFAULT_WEEKS = 10

_CACHE_TTL_SEC = 6 * 3600  # reports are weekly


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _query(where: str, limit: int) -> list[dict[str, Any]]:
    """Run a Socrata query against the first host that answers."""
    params = {
        "$where": where,
        "$order": "report_date_as_yyyy_mm_dd DESC",
        "$limit": str(limit),
    }
    last_error: Exception | None = None
    for url in SOCRATA_HOSTS:
        try:
            resp = requests.get(url, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list):
                return data
        except requests.RequestException as exc:  # try next host
            last_error = exc
    raise RuntimeError(f"CFTC Socrata API unreachable: {last_error}")


def _fetch_rows(code: str, name_prefix: str, limit: int) -> list[dict[str, Any]]:
    strict = (
        f"cftc_contract_market_code='{code}' AND "
        f"upper(market_and_exchange_names) like '{name_prefix}%'"
    )
    rows = _query(strict, limit)
    if not rows:  # name drifted over the years -> trust the market code
        rows = _query(f"cftc_contract_market_code='{code}'", limit)
    if not rows:
        raise ValueError(f"No COT rows returned for {name_prefix} ({code}).")
    return rows


def _group(row: dict[str, Any], prefix: str) -> dict[str, int]:
    long_ = _to_int(row.get(f"{prefix}_positions_long_all"))
    short = _to_int(row.get(f"{prefix}_positions_short_all"))
    return {"long": long_, "short": short, "net": long_ - short}


def _week(row: dict[str, Any]) -> dict[str, Any]:
    nc = _group(row, "noncomm")
    c = _group(row, "comm")
    nr = _group(row, "nonrept")
    return {
        "report_date": str(row.get("report_date_as_yyyy_mm_dd", ""))[:10],
        "non_commercials_long": nc["long"],
        "non_commercials_short": nc["short"],
        "non_commercials_net": nc["net"],
        "commercials_long": c["long"],
        "commercials_short": c["short"],
        "commercials_net": c["net"],
        "retail_long": nr["long"],
        "retail_short": nr["short"],
        "retail_net": nr["net"],
        "open_interest": _to_int(row.get("open_interest_all")),
    }


def _sentiment(non_commercials_net: int) -> str:
    if non_commercials_net > 0:
        return "BULLISH_INSTITUTIONAL"
    if non_commercials_net < 0:
        return "BEARISH_INSTITUTIONAL"
    return "NEUTRAL"


def get_cot(
    currency: str, weeks: int = DEFAULT_WEEKS, force: bool = False
) -> dict[str, Any]:
    """Latest snapshot + last `weeks` weekly reports for a FX currency future."""
    curr = currency.upper().strip()
    if curr not in CURRENCY_CONTRACTS:
        raise ValueError(f"Currency '{curr}' not supported. Use one of: {SUPPORTED}")

    weeks = max(2, min(int(weeks), 104))
    cache_key = f"cot:{curr}:{weeks}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict):
            return cached

    code, name_prefix = CURRENCY_CONTRACTS[curr]
    rows = _fetch_rows(code, name_prefix, weeks)

    history = [_week(r) for r in reversed(rows)]  # oldest -> newest
    latest = history[-1]
    prev = history[-2] if len(history) > 1 else latest

    payload: dict[str, Any] = {
        "currency": curr,
        "market": name_prefix,
        "market_code": code,
        "market_name": rows[0].get("market_and_exchange_names", ""),
        "report_date": latest["report_date"],
        "weeks": len(history),
        "commercials_net": latest["commercials_net"],
        "non_commercials_net": latest["non_commercials_net"],
        "retail_net": latest["retail_net"],
        "weekly_change": {
            "commercials_net": latest["commercials_net"] - prev["commercials_net"],
            "non_commercials_net": latest["non_commercials_net"]
            - prev["non_commercials_net"],
            "retail_net": latest["retail_net"] - prev["retail_net"],
        },
        "sentiment": _sentiment(latest["non_commercials_net"]),
        "history": history,
        "source": "CFTC Legacy Futures Only (Socrata 6dca-aqww)",
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload


# Backwards-compatible alias used by older callers.
def get_forex_cot(currency: str, history: int = DEFAULT_WEEKS) -> dict[str, Any]:
    return get_cot(currency, weeks=history)
