from fastapi import APIRouter, HTTPException, Query

from modules import kronos_forecast

router = APIRouter(prefix="/api/forecast", tags=["Forecast"])


@router.get("/{ticker}")
def get_forecast(
    ticker: str,
    interval: str = Query("5m", pattern="^(1m|2m|5m|15m|30m|60m|1h)$"),
    lookback: int = Query(400, ge=32, le=2048),
    pred_len: int = Query(24, ge=1, le=128),
    refresh: bool = Query(False, description="Bypass server cache"),
):
    """
    Kronos-mini OHLCV forecast for a symbol (optional ML stack).

    Returns available=false when PyTorch/Kronos are not installed.
    """
    try:
        return kronos_forecast.forecast(
            ticker,
            interval=interval,
            lookback=lookback,
            pred_len=pred_len,
            force=refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
