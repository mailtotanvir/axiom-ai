"""Retrieval API. Phase 2 (R3/R4) wires Qdrant search and the semantic cache."""

from __future__ import annotations

from fastapi import APIRouter, status

from app.models.schemas import RetrieveRequest, RetrieveResponse

router = APIRouter(prefix="/v1/knowledge", tags=["knowledge"])


@router.post(
    "/retrieve",
    response_model=RetrieveResponse,
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"description": "Index unavailable"}},
)
async def retrieve(request: RetrieveRequest) -> RetrieveResponse:
    """Hybrid dense+BM25 retrieval scoped to the caller's tenant namespace.

    Phase 0 stub: returns an empty result set; tenant scoping is enforced
    structurally in Phase 2 per ADR 0004.
    """
    return RetrieveResponse(chunks=[], served_from_cache=False)
