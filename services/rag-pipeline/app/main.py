"""Axiom AI RAG pipeline entrypoint (uvicorn target)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.api import health, ingestion, retrieval


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Phase 2: warm parser registry and vector-store pools here.
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="Axiom RAG Pipeline",
        version="0.1.0",
        description=(
            "Knowledge fabric: ingestion, chunking, semantic cache, multi-tenant retrieval."
        ),
        lifespan=lifespan,
    )
    app.include_router(health.router)
    app.include_router(ingestion.router)
    app.include_router(retrieval.router)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "AXIOM_INTERNAL",
                    "message": "Internal server error.",
                    "retryable": True,
                }
            },
        )

    return app


app = create_app()
