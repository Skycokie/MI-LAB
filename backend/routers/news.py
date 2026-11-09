from fastapi import APIRouter, HTTPException, Query

from modules import news

router = APIRouter(prefix="/api/news", tags=["News"])


@router.get("/status")
def get_status():
    """Which news providers are configured (never returns keys)."""
    return news.status()


@router.get("/{ticker}")
def get_news(
    ticker: str,
    limit: int = Query(20, ge=1, le=50),
    source: str = Query("auto", description="auto | financial-datasets | alpaca"),
    refresh: bool = Query(False),
):
    """Latest headlines for a ticker (Financial Datasets, Alpaca fallback)."""
    try:
        return news.get_news(ticker, limit=limit, source=source, force=refresh)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
