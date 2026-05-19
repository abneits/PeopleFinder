"""Initialisation idempotente du schéma SQL."""

from __future__ import annotations

from .db import get_pool

DDL = """
CREATE TABLE IF NOT EXISTS traces (
    id           UUID PRIMARY KEY,
    name         TEXT        NOT NULL,
    author       TEXT        NOT NULL,
    confidence   TEXT,
    recorded_at  DATE        NOT NULL,
    source       TEXT        NOT NULL CHECK (source IN ('gpx','manual')),
    points       JSONB       NOT NULL,
    bbox         JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ
);

-- Migrations idempotentes pour bases déjà créées avant l'introduction de `kind`
-- et avec une contrainte NOT NULL sur `confidence`.
ALTER TABLE traces ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'search';
ALTER TABLE traces ALTER COLUMN confidence DROP NOT NULL;

-- Contraintes CHECK idempotentes (Postgres n'a pas de IF NOT EXISTS sur ADD CONSTRAINT).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'traces_kind_check'
    ) THEN
        ALTER TABLE traces
            ADD CONSTRAINT traces_kind_check
            CHECK (kind IN ('search','todo'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'traces_confidence_check'
    ) THEN
        ALTER TABLE traces
            ADD CONSTRAINT traces_confidence_check
            CHECK (
                confidence IS NULL
                OR confidence IN ('low','medium','high')
            );
    END IF;
END
$$;

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
