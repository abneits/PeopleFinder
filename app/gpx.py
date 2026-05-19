"""Parsing GPX côté serveur (un seul parseur dans le projet)."""

from __future__ import annotations

from typing import List

import gpxpy
import gpxpy.gpx

from .models import MAX_GPX_BYTES, MAX_POINTS_PER_TRACE, Point


class GpxError(ValueError):
    """Erreur de parsing ou de validation GPX."""


def parse_gpx_bytes(raw: bytes) -> List[Point]:
    """Renvoie une liste de points `[lon, lat]` à partir d'un buffer GPX.

    Lève GpxError si :
      - le buffer dépasse MAX_GPX_BYTES,
      - le contenu n'est pas un GPX valide,
      - aucun point exploitable n'est trouvé,
      - le nombre de points dépasse MAX_POINTS_PER_TRACE.
    """
    if len(raw) > MAX_GPX_BYTES:
        raise GpxError("GPX file too large (max 1 MB)")
    if not raw.strip():
        raise GpxError("Empty GPX file")

    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise GpxError("GPX file is not valid UTF-8") from exc

    try:
        gpx = gpxpy.parse(text)
    except Exception as exc:  # gpxpy lève divers types
        raise GpxError(f"Invalid GPX content: {exc}") from exc

    points: List[Point] = []
    # Ordre: tracks > routes > waypoints isolés (le moins probable)
    for track in gpx.tracks:
        for segment in track.segments:
            for p in segment.points:
                points.append([float(p.longitude), float(p.latitude)])
    if not points:
        for route in gpx.routes:
            for p in route.points:
                points.append([float(p.longitude), float(p.latitude)])
    if not points:
        for p in gpx.waypoints:
            points.append([float(p.longitude), float(p.latitude)])

    if len(points) < 2:
        raise GpxError("GPX must contain at least 2 points")
    if len(points) > MAX_POINTS_PER_TRACE:
        raise GpxError(
            f"GPX has too many points (max {MAX_POINTS_PER_TRACE})"
        )

    return points
