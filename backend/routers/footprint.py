from fastapi import APIRouter, HTTPException, Query

from modules import footprint

router = APIRouter(prefix="/api/footprint", tags=["Footprint"])


@router.get("/{ticker}")
def get_footprint(
    ticker: str,
    interval: str = Query("15m", pattern="^(1m|5m|15m)$"),
    candles: int = Query(12, ge=1, le=48),
    imbalance_ratio: float = Query(3.0, ge=1.5, le=10.0),
    refresh: bool = Query(False, description="Bypass the server-side cache"),
):
    """
    Estimated footprint candles with diagonal bid/ask imbalances.
    """
    try:
        return footprint.build_footprint(
            ticker,
            interval=interval,
            candles=candles,
            imbalance_ratio=imbalance_ratio,
            force=refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
