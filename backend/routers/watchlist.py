from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from modules import basis, quotes, symbol_search, watchlist_scan

router = APIRouter(prefix="/api/watchlist", tags=["Watchlist"])


class SymbolsBody(BaseModel):
    symbols: list[str] = Field(..., min_length=1, max_length=40)


class ScanBody(BaseModel):
    symbols: list[str] = Field(..., min_length=1, max_length=40)
    interval: str = Field("15m", pattern="^(5m|15m)$")
    window: int = Field(20, ge=5, le=100)
    volume_mult: float = Field(1.8, ge=0.5, le=5.0)
    limit_per: int = Field(5, ge=1, le=20)
    refresh: bool = False


@router.get("/search")
def get_search(
    q: str = Query("", min_length=0, max_length=80, description="Name or ticker"),
    limit: int = Query(8, ge=1, le=20),
):
    """Yahoo symbol autocomplete for adding instruments to the watchlist."""
    try:
        return symbol_search.search_symbols(q, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/quotes")
def post_quotes(body: SymbolsBody):
    """Batch last price + day change for CFD / equity labels."""
    try:
        result = quotes.get_quotes(body.symbols)
        return {**result, "quotes": [basis.apply_quote_row(r) for r in result["quotes"]]}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/signals")
def post_signals(body: ScanBody):
    """Scan watchlist for estimated absorption signals (effort vs result)."""
    try:
        result = watchlist_scan.scan_watchlist(
            body.symbols,
            interval=body.interval,
            window=body.window,
            volume_mult=body.volume_mult,
            limit_per=body.limit_per,
            force=body.refresh,
        )
        return {
            **result,
            "per_symbol": [
                basis.apply(row["symbol"], row) for row in result.get("per_symbol", [])
            ],
            "signals": [basis.apply(s["symbol"], s) for s in result.get("signals", [])],
        }
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
