from fastapi import APIRouter, HTTPException, Query

from modules import momentum_scanner

router = APIRouter(prefix="/api/scanner", tags=["Scanner"])


@router.get("/momentum")
def get_momentum_scan(
    min_gap: float = Query(3.0, ge=0.0, le=50.0, description="Min |gap %| vs prev close"),
    min_rvol: float = Query(2.0, ge=0.0, le=50.0, description="Min relative volume"),
    min_price: float = Query(5.0, ge=0.0, le=10000.0),
    max_price: float = Query(100.0, ge=0.0, le=10000.0),
    refresh: bool = Query(False, description="Bypass server cache"),
):
    """US liquid-universe momentum scan (Yahoo delayed ~15m)."""
    try:
        return momentum_scanner.scan_momentum(
            min_gap_pct=min_gap,
            min_rvol=min_rvol,
            min_price=min_price,
            max_price=max_price,
            force=refresh,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
