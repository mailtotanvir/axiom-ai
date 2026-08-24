"""Ingestion API. Phase 2 (R1) replaces stubs with the Celery-backed pipeline."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, status

from app.models.schemas import IngestRequest, IngestStatus

router = APIRouter(prefix="/v1/knowledge", tags=["knowledge"])


@router.post(
    "/documents",
    response_model=IngestStatus,
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_document(request: IngestRequest) -> IngestStatus:
    """Queue a document for parsing/chunking/embedding.

    Phase 0 stub: returns an accepted envelope without side effects so the
    route contract is testable before workers exist.
    """
    document_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{request.tenant_id}:{request.filename}")
    return IngestStatus(document_id=str(document_id), state="queued")
