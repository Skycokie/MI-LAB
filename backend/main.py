"""
Institutional Market Insights API

Run from the backend/ directory:
    uvicorn main:app --reload --port 8000

Routers:
    /api/gex/{ticker}            Gamma Exposure (yfinance options chain)
    /api/cot/{currency}          CFTC COT via Socrata (EUR, GBP, JPY, CAD, AUD, ...)
    /api/volume-profile/{ticker} Volume Profile (POC / VAH / VAL)
    /api/absorption/{ticker}     Institutional absorption (effort vs result)
    /api/footprint/{ticker}      Estimated footprint imbalances
    /api/watchlist/search        Yahoo symbol autocomplete
    /api/watchlist/quotes        Batch quotes for a CFD watchlist
    /api/watchlist/signals       Absorption scan across a watchlist
    /api/scanner/momentum        US momentum scan (Yahoo delayed)
    /api/forecast/{ticker}       Kronos-mini OHLCV forecast (optional)
    /api/alerts                  Watchlist alerts + Alpaca Paper risk
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

# Load backend/.env so Alpaca (and optional HTX) keys are available via os.environ.
load_dotenv(Path(__file__).resolve().parent / ".env")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from modules import alerts_engine, cvd
from routers import (
    absorption,
    alerts,
    cot,
    forecast,
    footprint,
    gex,
    scanner,
    volume_profile,
    watchlist,
)

logger = logging.getLogger("mil.alerts")

_ALERT_POLL_SEC = float(os.getenv("ALERT_POLL_SEC", "60"))


async def _alerts_poller() -> None:
    """Background watchlist scan every ALERT_POLL_SEC seconds."""
    # Small delay so the app finishes booting.
    await asyncio.sleep(5)
    while True:
        try:
            result = await asyncio.to_thread(alerts_engine.run_scan)
            if result.get("fired_count"):
                logger.info(
                    "alerts scan: scanned=%s fired=%s",
                    result.get("scanned"),
                    result.get("fired_count"),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("alerts poller error")
        await asyncio.sleep(_ALERT_POLL_SEC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_alerts_poller())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="Institutional Market Insights API",
    version="0.7.0",
    description=(
        "GEX, CFTC COT, Volume Profile, Footprint, absorption, "
        "watchlist tracking, US momentum scanner, Kronos forecast, "
        "and watchlist alerts with Alpaca Paper risk."
    ),
    lifespan=lifespan,
)

# Frontend origins allowed to call the API (override with CORS_ORIGINS=a,b,c).
_default_origins = "http://localhost:3000,http://127.0.0.1:3000"
_allow_origins = [
    o.strip()
    for o in os.getenv("CORS_ORIGINS", _default_origins).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(gex.router)
app.include_router(cot.router)
app.include_router(volume_profile.router)
app.include_router(absorption.router)
app.include_router(footprint.router)
app.include_router(watchlist.router)
app.include_router(scanner.router)
app.include_router(forecast.router)
app.include_router(alerts.router)


@app.get("/")
def root():
    return {
        "status": "API funcțional",
        "docs": "/docs",
        "endpoints": [
            "/api/gex/{ticker}",
            "/api/cot/{currency}",
            "/api/volume-profile/{ticker}",
            "/api/absorption/{ticker}",
            "/api/footprint/{ticker}",
            "/api/watchlist/search",
            "/api/watchlist/quotes",
            "/api/watchlist/signals",
            "/api/scanner/momentum",
            "/api/forecast/{ticker}",
            "/api/alerts",
            "/api/alerts/risk",
            "/api/alerts/run",
        ],
    }


@app.get("/api/cvd/{symbol}", tags=["CVD"])
def get_cvd(symbol: str):
    """CVD placeholder - Phase 2."""
    try:
        return cvd.compute_cvd(symbol)
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
