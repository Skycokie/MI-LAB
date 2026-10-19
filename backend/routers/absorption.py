from fastapi import APIRouter, HTTPException, Query

from modules import absorption

router = APIRouter(prefix="/api/absorption", tags=["Absorption"])


@router.get("/{ticker}")
def get_absorption(
    ticker: str,
    interval: str = Query("5m", pattern="^(1m|5m|15m)$"),
    window: int = Query(20, ge=5, le=100),
    volume_mult: float = Query(1.8, ge=0.5, le=5.0),
    limit: int = Query(20, ge=1, le=100),
    refresh: bool = Query(False, description="Bypass the server-side cache"),
):
    """
    Institutional absorption signals (effort vs result) from estimated
    order-flow candles.
    """
    try:
        return absorption.get_absorption_signals(
            ticker,
            interval=interval,
            window=window,
            volume_mult=volume_mult,
            limit=limit,
            force=refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
