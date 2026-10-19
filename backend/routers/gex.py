from fastapi import APIRouter, HTTPException, Query

from modules import gex

router = APIRouter(prefix="/api/gex", tags=["GEX"])


@router.get("/{ticker}")
def get_gamma_exposure(
    ticker: str,
    expirations: int = Query(4, ge=1, le=8, description="Number of expiries to aggregate"),
    refresh: bool = Query(False, description="Bypass the server-side cache"),
):
    """Gamma Exposure per strike from the Yahoo Finance options chain."""
    try:
        return gex.compute_gex(ticker, expirations=expirations, force=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
