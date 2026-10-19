from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from modules import alerts_engine, alerts_store, alpaca_trading

router = APIRouter(prefix="/api/alerts", tags=["Alerts"])


class WatchSymbol(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=32)
    label: str | None = Field(None, max_length=64)


class WatchlistBody(BaseModel):
    symbols: list[WatchSymbol] = Field(default_factory=list, max_length=40)


class MarkReadBody(BaseModel):
    ids: list[str] | None = None
    all: bool = False


@router.put("/watchlist")
def put_watchlist(body: WatchlistBody):
    """Sync Lab watchlist to server for background scanning."""
    try:
        items = [{"symbol": s.symbol, "label": s.label} for s in body.symbols]
        saved = alerts_store.set_watchlist(items)
        return {"ok": True, "count": len(saved), "symbols": saved}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/watchlist")
def get_watchlist():
    return {"symbols": alerts_store.get_watchlist()}


@router.get("")
def get_alerts(
    unread_only: bool = Query(False),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        items = alerts_store.list_alerts(unread_only=unread_only, limit=limit)
        return {
            "alerts": items,
            "unread": alerts_store.unread_count(),
            "count": len(items),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/mark-read")
def post_mark_read(body: MarkReadBody):
    try:
        n = alerts_store.mark_read(ids=body.ids, all_alerts=body.all)
        return {"ok": True, "marked": n, "unread": alerts_store.unread_count()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/risk")
def get_risk():
    try:
        return alpaca_trading.get_risk_snapshot()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/run")
def post_run_scan() -> dict[str, Any]:
    """Force one scan cycle (also used by Refresh)."""
    try:
        return alerts_engine.run_scan()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
