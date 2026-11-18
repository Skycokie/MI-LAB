from fastapi import APIRouter, HTTPException, Query

from modules import alpaca_stream, basis, capital_data, smc

router = APIRouter(prefix="/api/smc", tags=["SMC / ICT"])


@router.get("/stream/status")
def get_stream_status():
    """Alpaca IEX WebSocket collector health (QQQ/SPY/DIA live bars)."""
    return alpaca_stream.status()


@router.get("/capital/status")
def get_capital_status():
    """Capital.com CFD session health (read-only market data)."""
    return capital_data.status()


@router.get("/{ticker}")
def get_smc(
    ticker: str,
    interval: str = Query("5m", pattern="^(1m|5m|15m|1h)$"),
    bars: int = Query(240, ge=80, le=500),
    min_atr_mult: float = Query(0.15, ge=0.0, le=1.5),
    swing_len: int = Query(3, ge=2, le=8),
    refresh: bool = Query(False, description="Bypass server-side cache"),
):
    """Fair Value Gaps (FVG), Order Blocks, BOS/CHoCH, BSL/SSL liquidity & ICT Dealing Range."""
    try:
        data = smc.compute_smc(
            ticker,
            interval=interval,
            bars=bars,
            min_atr_mult=min_atr_mult,
            swing_len=swing_len,
            force=refresh,
        )
        return basis.apply(ticker, data)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502, detail=f"SMC computation failed: {exc}"
        ) from exc
