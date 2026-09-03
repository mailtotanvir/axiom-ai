"""Axiom AI RAG pipeline entrypoint (uvicorn target).

Wires the full Phase 2 stack: parsers, chunkers, embeddings, vector store,
document store, semantic cache, retrieval service, and service auth.

Tests call `create_app(settings=…, vectors_override=InMemoryVectorStore())`
for deterministic behavior; production boots with env config + Qdrant.
"""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, status
from fastapi.responses import JSONResponse
from starlette.requests import Request as StarletteRequest
from starlette.responses import PlainTextResponse
from starlette.responses import Response as StarletteResponse

from app.api import health, knowledge
from app.core.config import Settings, get_settings
from app.core.documents import build_document_store
from app.core.embeddings import build_embedding_provider
from app.core.metrics import record_request, registry
from app.core.vectorstore import QdrantRestVectorStore, VectorStore
from app.services.ingestion import IngestionService
from app.services.retrieval import RetrievalService
from app.services.semantic_cache import SemanticCache


class Background:
    """Fire-and-forget task runner for routes that only hold `Request`."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    def add_task(self, fn: Callable[..., object], *args: object) -> None:
        task = asyncio.get_running_loop().create_task(_run_safe(fn, *args))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


async def _run_safe(fn: Callable[..., object], *args: object) -> None:
    """Failures persist in the pipeline; background tasks never raise."""
    try:
        result = fn(*args)
        if inspect.isawaitable(result):
            await result
    except Exception:  # noqa: BLE001
        pass


def _axiom_error_contract(app: FastAPI) -> None:
    from starlette.exceptions import HTTPException as StarletteHTTPException

    @app.exception_handler(StarletteHTTPException)
    async def http_exception(
        request: StarletteRequest, exc: StarletteHTTPException
    ) -> StarletteResponse:
        if isinstance(exc.detail, dict):
            content: object = exc.detail
        else:
            code = "AXIOM_INTERNAL" if exc.status_code >= 500 else "AXIOM_VALIDATION_FAILED"
            content = {
                "error": {
                    "code": code,
                    "message": str(exc.detail),
                    "retryable": False,
                }
            }
        return JSONResponse(
            status_code=exc.status_code,
            content=content,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def unhandled(request: StarletteRequest, exc: Exception) -> StarletteResponse:
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


def create_app(
    settings: Settings | None = None,
    vectors_override: VectorStore | None = None,
) -> FastAPI:
    """Builds the app with injectable settings/vector store for tests."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        resolved: Settings = settings or get_settings()
        app.state.settings = resolved

        if vectors_override is not None:
            vectors: VectorStore = vectors_override
        elif resolved.QDRANT_URL:
            vectors = QdrantRestVectorStore(resolved.QDRANT_URL, client=httpx.Client(timeout=30))
        else:
            from app.core.vectorstore import InMemoryVectorStore

            vectors = InMemoryVectorStore()

        documents = build_document_store(resolved)
        embeddings = build_embedding_provider(resolved)
        cache = SemanticCache(resolved, vectors, embeddings)

        app.state.vectors = vectors
        app.state.documents = documents
        app.state.embeddings = embeddings
        app.state.cache = cache
        app.state.ingestion = IngestionService(resolved, documents, vectors, embeddings)
        app.state.retrieval = RetrievalService(resolved, vectors, embeddings, cache)
        app.state.failed_raw = {}
        app.state.background = Background()
        yield

    built = FastAPI(
        title="Axiom RAG Pipeline",
        version="0.2.0",
        description=(
            "Knowledge fabric: ingestion, chunking, semantic cache, multi-tenant retrieval."
        ),
        lifespan=lifespan,
    )
    _axiom_error_contract(built)

    @built.middleware("http")
    async def metrics_middleware(
        request: StarletteRequest, call_next: Callable[[StarletteRequest], object]
    ) -> StarletteResponse:
        start_time = time.perf_counter()
        response = await call_next(request)  # type: ignore[misc]
        duration = time.perf_counter() - start_time
        route = request.url.path
        record_request(request.method, route, response.status_code, duration)
        return response

    @built.get("/metrics")
    async def metrics_endpoint() -> StarletteResponse:
        return PlainTextResponse(
            registry.get_metrics_text(),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    built.include_router(health.router)
    built.include_router(knowledge.router_ingest)
    built.include_router(knowledge.router_retrieve)
    return built


app = create_app()
