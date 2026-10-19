from fastapi import APIRouter, HTTPException, Query

from modules import volume_profile

router = APIRouter(prefix="/api/volume-profile", tags=["Volume Profile"])


@router.get("/{ticker}")
def get_volume_profile(
    ticker: str,
    bins: int = Query(40, ge=10, le=200),
    interval: str = Query("5m", pattern="^(1m|2m|5m|15m)$"),
    refresh: bool = Query(False, description="Bypass the server-side cache"),
):
    """Prior-session Volume Profile (POC / VAH / VAL) plus candles for charting."""
    try:
        return volume_profile.compute_volume_profile(
            ticker, bins=bins, interval=interval, force=refresh
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
