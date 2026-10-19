from fastapi import APIRouter, HTTPException, Query

from modules import cot

router = APIRouter(tags=["COT"])


@router.get("/api/cot/{currency}")
def get_cot(
    currency: str,
    weeks: int = Query(cot.DEFAULT_WEEKS, ge=2, le=104, description="Weekly reports to return"),
    refresh: bool = Query(False, description="Bypass the server-side cache"),
):
    """CFTC COT (Legacy Futures Only) for EUR, GBP, JPY, CAD, AUD, ..."""
    try:
        return cot.get_cot(currency, weeks=weeks, force=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/api/forex/cot/{currency}", include_in_schema=False)
def get_cot_legacy_path(
    currency: str,
    history: int = Query(cot.DEFAULT_WEEKS, ge=2, le=104),
    refresh: bool = False,
):
    """Backwards-compatible alias of /api/cot/{currency}."""
    return get_cot(currency, weeks=history, refresh=refresh)
