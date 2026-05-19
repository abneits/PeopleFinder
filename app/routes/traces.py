"""Endpoints CRUD pour les traces.

Note: pas d'auth, pas de rate limiting (PoC, cf. AGENTS.md).
Suppression = soft-delete (UPDATE deleted_at = NOW()), idempotente.
"""

from __future__ import annotations

import json
from datetime import date
from typing import List, Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile
from psycopg.types.json import Jsonb

from ..db import get_pool
from ..gpx import GpxError, parse_gpx_bytes
from ..models import (
    MAX_GPX_BYTES,
    BBox,
    Confidence,
    GpxMetadata,
    Source,
    TraceCreate,
    TraceOut,
    compute_bbox,
)

router = APIRouter(prefix="/traces", tags=["traces"])


def _row_to_trace(row) -> TraceOut:
    return TraceOut(
        id=row[0],
        name=row[1],
        author=row[2],
        confidence=Confidence(row[3]),
        recorded_at=row[4],
        source=Source(row[5]),
        points=row[6],
        bbox=BBox(**row[7]),
        created_at=row[8],
        deleted_at=row[9],
    )


_SELECT_COLS = (
    "id, name, author, confidence, recorded_at, source, "
    "points, bbox, created_at, deleted_at"
)


@router.get("", response_model=List[TraceOut])
def list_traces(
    include_deleted: bool = Query(False),
) -> List[TraceOut]:
    pool = get_pool()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            if include_deleted:
                cur.execute(
                    f"SELECT {_SELECT_COLS} FROM traces ORDER BY created_at DESC"
                )
            else:
                cur.execute(
                    f"SELECT {_SELECT_COLS} FROM traces "
                    "WHERE deleted_at IS NULL "
                    "ORDER BY created_at DESC"
                )
            rows = cur.fetchall()
    return [_row_to_trace(r) for r in rows]


def _insert_trace(
    *,
    name: str,
    author: str,
    confidence: Confidence,
    recorded_at: date,
    source: Source,
    points: list,
    bbox: BBox,
) -> TraceOut:
    new_id = uuid4()
    pool = get_pool()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO traces
                    (id, name, author, confidence, recorded_at,
                     source, points, bbox)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {_SELECT_COLS}
                """,
                (
                    str(new_id),
                    name,
                    author,
                    confidence.value,
                    recorded_at,
                    source.value,
                    Jsonb(points),
                    Jsonb(bbox.model_dump()),
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_trace(row)


@router.post("", response_model=TraceOut, status_code=201)
def create_trace_manual(payload: TraceCreate) -> TraceOut:
    bbox = compute_bbox(payload.points)
    return _insert_trace(
        name=payload.name.strip(),
        author=payload.author.strip(),
        confidence=payload.confidence,
        recorded_at=payload.recorded_at,
        source=Source.manual,
        points=payload.points,
        bbox=bbox,
    )


@router.post("/gpx", response_model=TraceOut, status_code=201)
async def create_trace_gpx(
    file: UploadFile = File(...),
    metadata: str = Form(..., description="JSON: name, author, confidence, recorded_at"),
) -> TraceOut:
    # Lecture stream avec garde-fou sur la taille
    raw = await file.read(MAX_GPX_BYTES + 1)
    if len(raw) > MAX_GPX_BYTES:
        raise HTTPException(status_code=413, detail="GPX file too large (max 1 MB)")

    try:
        meta_dict = json.loads(metadata)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="metadata must be valid JSON")
    try:
        meta = GpxMetadata(**meta_dict)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid metadata: {exc}")

    try:
        points = parse_gpx_bytes(raw)
    except GpxError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    bbox = compute_bbox(points)
    return _insert_trace(
        name=meta.name.strip(),
        author=meta.author.strip(),
        confidence=meta.confidence,
        recorded_at=meta.recorded_at,
        source=Source.gpx,
        points=points,
        bbox=bbox,
    )


@router.delete("/{trace_id}", status_code=204, response_class=Response)
def delete_trace(trace_id: UUID) -> Response:
    """Soft-delete idempotent.

    - Trace inconnue → 404.
    - Trace déjà supprimée → no-op 204 (idempotent).
    - Trace vivante → UPDATE deleted_at = NOW().
    """
    pool = get_pool()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT deleted_at FROM traces WHERE id = %s",
                (str(trace_id),),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail="Trace not found")
            if row[0] is None:
                cur.execute(
                    "UPDATE traces SET deleted_at = NOW() WHERE id = %s",
                    (str(trace_id),),
                )
        conn.commit()
    return Response(status_code=204)
