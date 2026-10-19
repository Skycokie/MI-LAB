"""
Persistent JSON key-value cache backed by SQLite.

Survives uvicorn reloads so Yahoo / CFTC are not hammered on every restart.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DB_PATH = _DATA_DIR / "cache.db"
_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), timeout=30, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def _ensure_schema() -> None:
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        conn = _connect()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS kv_cache (
                    cache_key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_cache(expires_at)"
            )
            conn.commit()
        finally:
            conn.close()
        _initialized = True


def get(key: str) -> dict[str, Any] | list[Any] | None:
    """Return cached JSON payload if present and not expired."""
    _ensure_schema()
    now = time.time()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT payload, expires_at FROM kv_cache WHERE cache_key = ?",
                (key,),
            ).fetchone()
            if not row:
                return None
            payload_raw, expires_at = row
            if expires_at < now:
                conn.execute("DELETE FROM kv_cache WHERE cache_key = ?", (key,))
                conn.commit()
                return None
            return json.loads(payload_raw)
        finally:
            conn.close()


def set(key: str, payload: Any, ttl_sec: float) -> None:
    """Store JSON-serializable payload with a TTL in seconds."""
    _ensure_schema()
    now = time.time()
    expires_at = now + max(1.0, float(ttl_sec))
    blob = json.dumps(payload, default=str)
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO kv_cache (cache_key, payload, expires_at, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    payload = excluded.payload,
                    expires_at = excluded.expires_at,
                    created_at = excluded.created_at
                """,
                (key, blob, expires_at, now),
            )
            conn.commit()
        finally:
            conn.close()


def delete(key: str) -> None:
    _ensure_schema()
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM kv_cache WHERE cache_key = ?", (key,))
            conn.commit()
        finally:
            conn.close()


def clear_expired() -> int:
    """Delete expired rows; returns number of deleted keys."""
    _ensure_schema()
    now = time.time()
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute(
                "DELETE FROM kv_cache WHERE expires_at < ?", (now,)
            )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()
