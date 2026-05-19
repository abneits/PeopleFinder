"""Endpoints CRUD pour les traces (recherche ou tracé à explorer).

Note: pas d'auth, pas de rate limiting (PoC, cf. AGENTS.md).
Suppression = soft-delete (UPDATE deleted_at = NOW()), idempotente.
"""

from __future__ import annotations

import json
from datetime import date
from typing import List, Optional
from uuid import UUID, uuid4

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
)
from psycopg.types.json import Jsonb

from ..db import get_pool
from ..gpx import GpxError, parse_gpx_bytes
from ..models import (
    MAX_GPX_BYTES,
    BBox,
    Confidence,
    GpxMetadata,
    Kind,
    Source,
    TodoCreate,
    TodoGpxMetadata,
    TraceCreate,
    TraceOut,
    compute_bbox,
)

router = APIRouter(prefix="/traces", tags=["traces"])


def _row_to_trace(row) -> TraceOut:
    confidence = Confidence(row[3]) if row[3] is not None else None
    return TraceOut(
        id=row[0],
        name=row[1],
        author=row[2],
        confidence=confidence,
        recorded_at=row[4],
        source=Source(row[5]),
        kind=Kind(row[6]),
        points=row[7],
        bbox=BBox(**row[8]),
        created_at=row[9],
        deleted_at=row[10],
    )


_SELECT_COLS = (
    "id, name, author, confidence, recorded_at, source, kind, "
    "points, bbox, created_at, deleted_at"
)


@router.get("", response_model=List[TraceOut])
def list_traces(
    include_deleted: bool = Query(False),
    kind: Optional[Kind] = Query(
        None, description="Filtre par type. Absent = les deux."
    ),
) -> List[TraceOut]:
    pool = get_pool()
    clauses: List[str] = []
    params: List[object] = []
    if not include_deleted:
        clauses.append("deleted_at IS NULL")
    if kind is not None:
        clauses.append("kind = %s")
        params.append(kind.value)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = f"SELECT {_SELECT_COLS} FROM traces{where} ORDER BY created_at DESC"
    with pool.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
    return [_row_to_trace(r) for r in rows]


def _insert_trace(
    *,
    name: str,
    author: str,
    confidence: Optional[Confidence],
    recorded_at: date,
    source: Source,
    kind: Kind,
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
                     source, kind, points, bbox)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING {_SELECT_COLS}
                """,
                (
                    str(new_id),
                    name,
                    author,
                    confidence.value if confidence is not None else None,
                    recorded_at,
                    source.value,
                    kind.value,
                    Jsonb(points),
                    Jsonb(bbox.model_dump()),
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return _row_to_trace(row)


# ===== Recherche (kind=search) =====

@router.post("", response_model=TraceOut, status_code=201)
def create_trace_manual(payload: TraceCreate) -> TraceOut:
    bbox = compute_bbox(payload.points)
    return _insert_trace(
        name=payload.name.strip(),
        author=payload.author.strip(),
        confidence=payload.confidence,
        recorded_at=payload.recorded_at,
        source=Source.manual,
        kind=Kind.search,
        points=payload.points,
        bbox=bbox,
    )


@router.post("/gpx", response_model=TraceOut, status_code=201)
async def create_trace_gpx(
    file: UploadFile = File(...),
    metadata: str = Form(..., description="JSON: name, author, confidence, recorded_at"),
) -> TraceOut:
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
        kind=Kind.search,
        points=points,
        bbox=bbox,
    )


# ===== Tracé à explorer (kind=todo) =====

@router.post("/todo", response_model=TraceOut, status_code=201)
def create_todo_manual(payload: TodoCreate) -> TraceOut:
    bbox = compute_bbox(payload.points)
    return _insert_trace(
        name=payload.name.strip(),
        author=payload.author.strip(),
        confidence=None,
        recorded_at=payload.recorded_at,
        source=Source.manual,
        kind=Kind.todo,
        points=payload.points,
        bbox=bbox,
    )


@router.post("/todo/gpx", response_model=TraceOut, status_code=201)
async def create_todo_gpx(
    file: UploadFile = File(...),
    metadata: str = Form(..., description="JSON: name, author, recorded_at"),
) -> TraceOut:
    raw = await file.read(MAX_GPX_BYTES + 1)
    if len(raw) > MAX_GPX_BYTES:
        raise HTTPException(status_code=413, detail="GPX file too large (max 1 MB)")

    try:
        meta_dict = json.loads(metadata)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="metadata must be valid JSON")
    try:
        meta = TodoGpxMetadata(**meta_dict)
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
        confidence=None,
        recorded_at=meta.recorded_at,
        source=Source.gpx,
        kind=Kind.todo,
        points=points,
        bbox=bbox,
    )


# ===== Suppression (commun aux deux types) =====

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
