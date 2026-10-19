"""
SQLite persistence for alert watchlist + fired alerts.
Shares the backend/data/ directory with disk_cache.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_DB_PATH = _DATA_DIR / "alerts.db"
_lock = threading.Lock()
_initialized = False

_COOLDOWN_SEC = 45 * 60  # 45 min per symbol+rule


def _connect() -> sqlite3.Connection:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
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
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS alert_watchlist (
                    symbol TEXT PRIMARY KEY,
                    label TEXT,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS alerts (
                    id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    rule TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    message TEXT NOT NULL,
                    payload_json TEXT,
                    created_at REAL NOT NULL,
                    read INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS idx_alerts_created
                    ON alerts(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_alerts_unread
                    ON alerts(read, created_at DESC);
                CREATE TABLE IF NOT EXISTS alert_cooldowns (
                    key TEXT PRIMARY KEY,
                    last_fired REAL NOT NULL
                );
                """
            )
            conn.commit()
        finally:
            conn.close()
        _initialized = True


def set_watchlist(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Replace server watchlist. items: [{symbol, label?}]. Max 40."""
    _ensure_schema()
    now = time.time()
    cleaned: list[tuple[str, str | None, float]] = []
    seen: set[str] = set()
    for raw in items[:40]:
        sym = str(raw.get("symbol", "")).upper().strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        label = raw.get("label")
        label_s = str(label).strip() if label else None
        cleaned.append((sym, label_s, now))

    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM alert_watchlist")
            conn.executemany(
                "INSERT INTO alert_watchlist(symbol, label, updated_at) VALUES (?,?,?)",
                cleaned,
            )
            conn.commit()
        finally:
            conn.close()
    return [{"symbol": s, "label": l or s} for s, l, _ in cleaned]


def get_watchlist() -> list[dict[str, str]]:
    _ensure_schema()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT symbol, label FROM alert_watchlist ORDER BY symbol"
            ).fetchall()
        finally:
            conn.close()
    return [
        {"symbol": r["symbol"], "label": r["label"] or r["symbol"]} for r in rows
    ]


def can_fire(symbol: str, rule: str, cooldown_sec: float = _COOLDOWN_SEC) -> bool:
    _ensure_schema()
    key = f"{symbol.upper()}|{rule}"
    now = time.time()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT last_fired FROM alert_cooldowns WHERE key = ?", (key,)
            ).fetchone()
            if row and (now - float(row["last_fired"])) < cooldown_sec:
                return False
            return True
        finally:
            conn.close()


def mark_fired(symbol: str, rule: str) -> None:
    _ensure_schema()
    key = f"{symbol.upper()}|{rule}"
    now = time.time()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO alert_cooldowns(key, last_fired) VALUES (?,?)
                ON CONFLICT(key) DO UPDATE SET last_fired = excluded.last_fired
                """,
                (key, now),
            )
            conn.commit()
        finally:
            conn.close()


def insert_alert(
    symbol: str,
    rule: str,
    severity: str,
    message: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ensure_schema()
    alert_id = str(uuid.uuid4())
    now = time.time()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO alerts(id, symbol, rule, severity, message, payload_json, created_at, read)
                VALUES (?,?,?,?,?,?,?,0)
                """,
                (
                    alert_id,
                    symbol.upper(),
                    rule,
                    severity,
                    message,
                    json.dumps(payload or {}),
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()
    mark_fired(symbol, rule)
    return {
        "id": alert_id,
        "symbol": symbol.upper(),
        "rule": rule,
        "severity": severity,
        "message": message,
        "payload": payload or {},
        "created_at": now,
        "read": False,
    }


def list_alerts(
    unread_only: bool = False, limit: int = 100
) -> list[dict[str, Any]]:
    _ensure_schema()
    limit = max(1, min(int(limit), 500))
    with _lock:
        conn = _connect()
        try:
            if unread_only:
                rows = conn.execute(
                    """
                    SELECT * FROM alerts WHERE read = 0
                    ORDER BY created_at DESC LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        finally:
            conn.close()
    out: list[dict[str, Any]] = []
    for r in rows:
        payload: Any = {}
        try:
            payload = json.loads(r["payload_json"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        out.append(
            {
                "id": r["id"],
                "symbol": r["symbol"],
                "rule": r["rule"],
                "severity": r["severity"],
                "message": r["message"],
                "payload": payload,
                "created_at": r["created_at"],
                "read": bool(r["read"]),
            }
        )
    return out


def unread_count() -> int:
    _ensure_schema()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM alerts WHERE read = 0"
            ).fetchone()
            return int(row["c"] if row else 0)
        finally:
            conn.close()


def mark_read(ids: list[str] | None = None, all_alerts: bool = False) -> int:
    _ensure_schema()
    with _lock:
        conn = _connect()
        try:
            if all_alerts:
                cur = conn.execute("UPDATE alerts SET read = 1 WHERE read = 0")
            elif ids:
                placeholders = ",".join("?" * len(ids))
                cur = conn.execute(
                    f"UPDATE alerts SET read = 1 WHERE id IN ({placeholders})",
                    ids,
                )
            else:
                return 0
            conn.commit()
            return cur.rowcount or 0
        finally:
            conn.close()
