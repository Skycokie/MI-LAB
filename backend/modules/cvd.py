"""
Cumulative Volume Delta (CVD) — Phase 2 stub.

Planned approach (not implemented in Phase 1):
  - Intraday 1m bars from yfinance (or a tick feed).
  - Approximate buy/sell volume: if Close >= Open → buy volume, else sell.
  - CVD_t = sum(buy_vol - sell_vol) over the session.
  - Divergences vs price for institutional absorption / distribution.

Public API shape (future):
  GET /api/cvd/{symbol} → { symbol, session_date, series: [{t, cvd, price}] }
"""

from __future__ import annotations

from typing import Any


def compute_cvd(symbol: str) -> dict[str, Any]:
    """Placeholder until Phase 2."""
    raise NotImplementedError(
        f"CVD for '{symbol}' is planned for Phase 2 "
        "(intraday buy/sell volume approximation)."
    )
