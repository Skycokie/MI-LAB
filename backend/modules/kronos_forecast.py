"""
Optional Kronos OHLCV forecast (foundation model from NeoQuasar / shiyu-coder).

Lazy-loads Kronos-mini. If torch / HF / model code are missing, returns
available=false so the Lab still runs without the heavy ML stack.
"""

from __future__ import annotations

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from pathlib import Path
from typing import Any

import pandas as pd

from modules import disk_cache, market_data
from modules.volume_profile import resolve_symbol

_CACHE_TTL_SEC = 300
_MODEL_NAME = "NeoQuasar/Kronos-mini"
_TOKENIZER_NAME = "NeoQuasar/Kronos-Tokenizer-2k"
_MAX_CONTEXT = 2048  # Kronos-mini tokenizer context
# Railway CPU / RAM: keep lookback modest so inference finishes before proxy timeout.
_MAX_LOOKBACK = max(32, min(int(os.getenv("KRONOS_MAX_LOOKBACK", "256")), _MAX_CONTEXT))
_INFERENCE_TIMEOUT_SEC = float(os.getenv("KRONOS_INFERENCE_TIMEOUT_SEC", "45"))

_KRONOS_ROOT = Path(__file__).resolve().parent.parent / "vendor" / "kronos"

_predictor_lock = threading.Lock()
_predictor = None
_predictor_error: str | None = None
_predictor_loading = False

# The vendored Kronos model keeps mutable per-module inference state (e.g. the
# RotaryPositionalEmbedding cos/sin cache, keyed only by sequence length — see
# backend/vendor/kronos/model/module.py). It is NOT safe for concurrent calls:
# two overlapping /api/forecast requests with different lookback/pred_len can
# race on that shared cache and blow up with tensor-size-mismatch errors deep
# inside attention (e.g. "size of tensor a (403) must match tensor b (402) at
# non-singleton dimension 2"). Serialize all inference through one lock.
_inference_lock = threading.Lock()
_infer_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kronos-infer")

_INTERVAL_MINUTES = {
    "1m": 1,
    "2m": 2,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "60m": 60,
    "1h": 60,
}

_SOURCE_LABEL = {
    "alpaca": "Alpaca",
    "htx": "HTX",
    "yahoo": "Yahoo",
}


def kronos_available() -> tuple[bool, str | None]:
    """Return (ok, error_message). Does not load weights."""
    try:
        import torch  # noqa: F401
    except ImportError:
        return False, (
            "PyTorch lipsește. Instalează stack-ul opțional: "
            "pip install -r requirements-kronos.txt (din folderul backend/)."
        )
    if not (_KRONOS_ROOT / "model" / "kronos.py").exists():
        return False, "Codul Kronos lipsește din backend/vendor/kronos/model/."
    return True, None


def _ensure_kronos_on_path() -> None:
    root = str(_KRONOS_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)


def _load_predictor_locked() -> None:
    """Load weights. Caller must hold `_predictor_lock`."""
    global _predictor, _predictor_error, _predictor_loading
    if _predictor is not None or _predictor_error is not None:
        return

    ok, err = kronos_available()
    if not ok:
        _predictor_error = err
        return

    _predictor_loading = True
    try:
        _ensure_kronos_on_path()
        from model import Kronos, KronosPredictor, KronosTokenizer

        tokenizer = KronosTokenizer.from_pretrained(_TOKENIZER_NAME)
        model = Kronos.from_pretrained(_MODEL_NAME)
        _predictor = KronosPredictor(model, tokenizer, max_context=_MAX_CONTEXT)
    except Exception as exc:
        _predictor_error = f"Nu s-a putut încărca Kronos-mini: {exc}"
    finally:
        _predictor_loading = False


def _get_predictor():
    global _predictor, _predictor_error
    if _predictor is not None:
        return _predictor
    if _predictor_error is not None:
        raise RuntimeError(_predictor_error)

    with _predictor_lock:
        if _predictor is not None:
            return _predictor
        if _predictor_error is not None:
            raise RuntimeError(_predictor_error)
        _load_predictor_locked()
        if _predictor is not None:
            return _predictor
        raise RuntimeError(_predictor_error or "Kronos-mini unavailable")


def predictor_ready() -> bool:
    return _predictor is not None


def predictor_status() -> dict[str, Any]:
    return {
        "ready": _predictor is not None,
        "loading": _predictor_loading,
        "error": _predictor_error,
    }


def warmup_in_background() -> None:
    """Start Kronos weight load off the request path (Railway cold start)."""
    ok, _ = kronos_available()
    if not ok:
        return
    if _predictor is not None or _predictor_error is not None or _predictor_loading:
        return

    def _run() -> None:
        with _predictor_lock:
            if _predictor is None and _predictor_error is None:
                _load_predictor_locked()

    threading.Thread(target=_run, name="kronos-warmup", daemon=True).start()


def _model_loading_payload(display: str, yahoo_symbol: str, proxy_note: str | None) -> dict[str, Any]:
    return {
        "available": False,
        "reason": "MODEL_LOADING",
        "ticker": display,
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "message": (
            "Kronos-mini se încarcă pe server (primul start durează ~1–2 min). "
            "Reîncearcă în câteva secunde."
        ),
        "model": _MODEL_NAME,
    }


def _busy_payload(display: str, yahoo_symbol: str, proxy_note: str | None) -> dict[str, Any]:
    return {
        "available": False,
        "reason": "MODEL_BUSY",
        "ticker": display,
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": proxy_note,
        "message": (
            "Kronos rulează deja o predicție. Reîncearcă în câteva secunde — "
            "nu bloca request-ul pe proxy timeout."
        ),
        "model": _MODEL_NAME,
    }


def _bar_unix(ts: pd.Timestamp) -> int:
    offset = ts.utcoffset().total_seconds() if ts.utcoffset() else 0
    return int(ts.timestamp() + offset)


def _candles_from_df(df: pd.DataFrame) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ts, row in df.iterrows():
        out.append(
            {
                "time": _bar_unix(ts),
                "open": round(float(row["open"]), 6),
                "high": round(float(row["high"]), 6),
                "low": round(float(row["low"]), 6),
                "close": round(float(row["close"]), 6),
                "volume": round(float(row.get("volume", 0) or 0), 2),
            }
        )
    return out


def _future_index(last_ts: pd.Timestamp, pred_len: int, minutes: int) -> pd.DatetimeIndex:
    # Business-like forward steps; Kronos mainly needs stamp features (hour/weekday).
    start = last_ts + pd.Timedelta(minutes=minutes)
    return pd.date_range(start=start, periods=pred_len, freq=f"{minutes}min")


def forecast(
    symbol: str,
    interval: str = "5m",
    lookback: int = 400,
    pred_len: int = 24,
    force: bool = False,
) -> dict[str, Any]:
    """
    Forecast next `pred_len` OHLCV bars for `symbol` using Kronos-mini.
    """
    display = symbol.upper().strip()
    interval = interval.strip().lower()
    if interval not in _INTERVAL_MINUTES:
        raise ValueError(
            f"Unsupported interval '{interval}'. Use one of: {sorted(_INTERVAL_MINUTES)}"
        )

    lookback = max(32, min(int(lookback), _MAX_LOOKBACK))
    pred_len = max(1, min(int(pred_len), 128))
    minutes = _INTERVAL_MINUTES[interval]

    ok, err = kronos_available()
    if not ok:
        return {
            "available": False,
            "reason": "KRONOS_NOT_INSTALLED",
            "ticker": display,
            "message": err,
            "install_hint": "pip install -r requirements-kronos.txt",
            "model": _MODEL_NAME,
        }

    yahoo_symbol, proxy_note = resolve_symbol(display)
    # Include provider config in cache key so switching keys invalidates old Yahoo payloads.
    provider_tag = (
        f"a{int(market_data.alpaca_configured())}"
        f"h{int(market_data.htx_configured())}"
    )
    cache_key = f"forecast:{provider_tag}:{yahoo_symbol}:{interval}:{lookback}:{pred_len}"
    if not force:
        cached = disk_cache.get(cache_key)
        if isinstance(cached, dict) and cached.get("available") is True:
            return cached

    # Never block the HTTP request on HF weight download — that exceeds Railway /
    # Next proxy timeouts and surfaces as a bare "Internal Server Error".
    if _predictor is None:
        if _predictor_error is not None:
            return {
                "available": False,
                "reason": "KRONOS_LOAD_FAILED",
                "ticker": display,
                "yahoo_symbol": yahoo_symbol,
                "proxy_note": proxy_note,
                "message": _predictor_error,
                "model": _MODEL_NAME,
            }
        warmup_in_background()
        return _model_loading_payload(display, yahoo_symbol, proxy_note)

    hist, source = market_data.fetch_history(
        display, yahoo_symbol, interval, lookback
    )
    need = ["open", "high", "low", "close"]
    working = hist.dropna(subset=need).copy()
    working["volume"] = working["volume"].fillna(0.0)
    working["amount"] = working["volume"] * working[need].mean(axis=1)

    if len(working) < lookback:
        lookback = len(working)
    if lookback < 32:
        raise ValueError(
            f"Not enough bars for forecast ({len(working)} < 32) on '{yahoo_symbol}'."
        )

    x_df = working.iloc[-lookback:][
        ["open", "high", "low", "close", "volume", "amount"]
    ].copy()
    # Kronos calc_time_stamps expects a Series with .dt (not DatetimeIndex).
    x_timestamp = pd.Series(pd.to_datetime(x_df.index))
    last_ts = x_timestamp.iloc[-1]
    y_timestamp = pd.Series(_future_index(last_ts, pred_len, minutes))

    # Non-blocking: if another forecast holds the lock, return immediately so
    # Next/Railway proxies do not surface a bare "Internal Server Error".
    if not _inference_lock.acquire(blocking=False):
        return _busy_payload(display, yahoo_symbol, proxy_note)

    lock_held = True
    try:
        predictor = _get_predictor()

        def _run_predict():
            return predictor.predict(
                df=x_df,
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=pred_len,
                T=1.0,
                top_p=0.9,
                sample_count=1,
                verbose=False,
            )

        fut = _infer_pool.submit(_run_predict)
        try:
            pred_df = fut.result(timeout=_INFERENCE_TIMEOUT_SEC)
        except FuturesTimeout:
            # Keep the lock until the late job finishes — Kronos is not re-entrant.
            def _release_when_done(f: Any) -> None:
                try:
                    f.result()
                except Exception:
                    pass
                finally:
                    _inference_lock.release()

            fut.add_done_callback(_release_when_done)
            lock_held = False
            return {
                "available": False,
                "reason": "KRONOS_TIMEOUT",
                "ticker": display,
                "yahoo_symbol": yahoo_symbol,
                "proxy_note": proxy_note,
                "message": (
                    f"Predicția a depășit {_INFERENCE_TIMEOUT_SEC:.0f}s pe server. "
                    "Încearcă Bars=12 sau TF=15m."
                ),
                "model": _MODEL_NAME,
            }
    except Exception as exc:
        return {
            "available": False,
            "reason": "KRONOS_INFERENCE_FAILED",
            "ticker": display,
            "yahoo_symbol": yahoo_symbol,
            "proxy_note": proxy_note,
            "message": str(exc),
            "model": _MODEL_NAME,
        }
    finally:
        if lock_held:
            _inference_lock.release()

    # Align column names for candle serialization.
    pred_out = pred_df.copy()
    pred_out.columns = [c.lower() for c in pred_out.columns]

    history_tail = min(120, lookback)
    hist_slice = x_df.iloc[-history_tail:]

    delayed = source == "yahoo"
    label = _SOURCE_LABEL.get(source, source)
    if delayed:
        disclaimer = (
            "Predicție probabilistică experimentală — nu este sfat de investiții. "
            "Feed Yahoo poate avea delay ~15 minute."
        )
        source_str = "yahoo+kronos-mini"
    else:
        disclaimer = (
            "Predicție probabilistică experimentală — nu este sfat de investiții. "
            f"Date live de la {label}."
        )
        source_str = f"{source}+kronos-mini"

    # When using live providers, Yahoo proxy mapping is irrelevant.
    note = proxy_note if delayed else None

    payload: dict[str, Any] = {
        "available": True,
        "ticker": display,
        "yahoo_symbol": yahoo_symbol,
        "proxy_note": note,
        "interval": interval,
        "lookback": lookback,
        "pred_len": pred_len,
        "model": _MODEL_NAME,
        "tokenizer": _TOKENIZER_NAME,
        "delayed": delayed,
        "source": source_str,
        "disclaimer": disclaimer,
        "history": _candles_from_df(hist_slice),
        "forecast": _candles_from_df(pred_out),
    }
    disk_cache.set(cache_key, payload, _CACHE_TTL_SEC)
    return payload
