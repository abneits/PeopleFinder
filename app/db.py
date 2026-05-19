"""Pool de connexions Postgres (psycopg v3, mode sync)."""

from __future__ import annotations

import os
from typing import Optional

from psycopg_pool import ConnectionPool

_pool: Optional[ConnectionPool] = None


def _normalize_dsn(dsn: str) -> str:
    # psycopg accepte les deux mais 'postgres://' est parfois mal interprété
    # par certaines libs ; on normalise sans risquer de casser.
    if dsn.startswith("postgres://"):
        return "postgresql://" + dsn[len("postgres://") :]
    return dsn


def init_pool() -> ConnectionPool:
    global _pool
    if _pool is not None:
        return _pool
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is not set")
    _pool = ConnectionPool(
        conninfo=_normalize_dsn(dsn),
        min_size=1,
        max_size=5,
        kwargs={"autocommit": False},
    )
    # Force l'ouverture pour échouer tôt si la DB est injoignable.
    _pool.wait(timeout=10.0)
    return _pool


def get_pool() -> ConnectionPool:
    if _pool is None:
        return init_pool()
    return _pool


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
