"""Entrée FastAPI : init DB au boot, montage statique, routes."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db import close_pool, init_pool
from .routes.traces import router as traces_router
from .schema import init_schema

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
log = logging.getLogger("peoplefinder")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Initializing DB pool")
    init_pool()
    log.info("Applying schema (idempotent)")
    init_schema()
    log.info("Startup complete")
    try:
        yield
    finally:
        log.info("Closing DB pool")
        close_pool()


app = FastAPI(title="PeopleFinder", lifespan=lifespan)

app.include_router(traces_router)


# Assets statiques (Leaflet est servi depuis un CDN dans index.html ;
# ici on sert juste notre app.js / style.css / etc.)
app.mount(
    "/static",
    StaticFiles(directory=str(STATIC_DIR)),
    name="static",
)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict:
    return {"status": "ok"}
