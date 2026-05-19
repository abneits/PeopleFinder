"""Initialisation idempotente du schéma SQL."""

from __future__ import annotations

from .db import get_pool

DDL = """
CREATE TABLE IF NOT EXISTS traces (
    id           UUID PRIMARY KEY,
    name         TEXT        NOT NULL,
    author       TEXT        NOT NULL,
    confidence   TEXT        NOT NULL CHECK (confidence IN ('low','medium','high')),
    recorded_at  DATE        NOT NULL,
    source       TEXT        NOT NULL CHECK (source IN ('gpx','manual')),
    points       JSONB       NOT NULL,
    bbox         JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS traces_alive_created_at_idx
    ON traces (created_at DESC)
    WHERE deleted_at IS NULL;
"""


def init_schema() -> None:
    pool = get_pool()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(DDL)
        conn.commit()
