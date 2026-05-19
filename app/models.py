"""Schémas Pydantic et constantes métier."""

from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


# Caps métier (cf. AGENTS.md / SPEC.md)
MAX_POINTS_PER_TRACE = 10_000
MAX_TEXT_LEN = 200
MAX_GPX_BYTES = 1 * 1024 * 1024  # 1 Mo


class Confidence(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class Source(str, Enum):
    gpx = "gpx"
    manual = "manual"


# Un point = [lon, lat] (style GeoJSON)
Point = List[float]


def _validate_point(p: Point) -> Point:
    if not isinstance(p, list) or len(p) != 2:
        raise ValueError("Each point must be a [lon, lat] pair")
    lon, lat = p
    if not (isinstance(lon, (int, float)) and isinstance(lat, (int, float))):
        raise ValueError("lon/lat must be numbers")
    if not (-180.0 <= float(lon) <= 180.0):
        raise ValueError("lon out of range")
    if not (-90.0 <= float(lat) <= 90.0):
        raise ValueError("lat out of range")
    return [float(lon), float(lat)]


class TraceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    author: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    confidence: Confidence
    recorded_at: date
    points: List[Point]

    @field_validator("points")
    @classmethod
    def _check_points(cls, v: List[Point]) -> List[Point]:
        if len(v) < 2:
            raise ValueError("A trace must contain at least 2 points")
        if len(v) > MAX_POINTS_PER_TRACE:
            raise ValueError(
                f"Too many points (max {MAX_POINTS_PER_TRACE})"
            )
        return [_validate_point(p) for p in v]


class GpxMetadata(BaseModel):
    """Métadonnées fournies en multipart à côté du fichier GPX."""

    name: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    author: str = Field(min_length=1, max_length=MAX_TEXT_LEN)
    confidence: Confidence
    recorded_at: date


class BBox(BaseModel):
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float


class TraceOut(BaseModel):
    id: UUID
    name: str
    author: str
    confidence: Confidence
    recorded_at: date
    source: Source
    points: List[Point]
    bbox: BBox
    created_at: datetime
    deleted_at: Optional[datetime]


def compute_bbox(points: List[Point]) -> BBox:
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return BBox(
        min_lon=min(lons),
        min_lat=min(lats),
        max_lon=max(lons),
        max_lat=max(lats),
    )
