"""Knowledge API over the real services (R1–R6).

All routes require service credentials (R5): X-Axiom-Tenant +
X-Axiom-Signature computed over the raw body with the inter-service
secret. Tenant identity never comes from caller-supplied JSON.
"""

from __future__ import annotations

import base64
import json

from fastapi import APIRouter, HTTPException, Request, status

from app.core.documents import DocumentRecord, DocumentStatus
from app.core.parsers import PARSERS
from app.core.service_auth import ServiceAuthError, VerifiedTenant, verify_service_tenant
from app.models.schemas import IngestStatus, RetrieveRequest, RetrieveResponse

router_ingest = APIRouter(prefix="/v1/knowledge", tags=["knowledge"])
router_retrieve = APIRouter(prefix="/v1/knowledge", tags=["knowledge"])


async def verified_tenant(request: Request) -> VerifiedTenant:
    secret = request.app.state.settings.AXIOM_INTER_SERVICE_SECRET
    try:
        return await verify_service_tenant(request, secret)
    except ServiceAuthError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"error": {"code": error.code, "message": error.message, "retryable": False}},
        ) from error


def _http(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message, "retryable": False}},
    )


def _parse_ingest_payload(raw_body: bytes, max_bytes: int) -> dict:
    """Validates the ingest envelope; returns {filename, project_id, raw}."""
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as error:
        raise ValueError("body must be valid JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("body must be a JSON object")

    filename = payload.get("filename")
    content_base64 = payload.get("content_base64")
    if not isinstance(filename, str) or not filename:
        raise ValueError("filename is required")
    if not isinstance(content_base64, str):
        raise ValueError("content_base64 is required")
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except Exception as error:  # noqa: BLE001
        raise ValueError("content_base64 is not valid base64") from error
    if len(raw) > max_bytes:
        raise ValueError(f"document exceeds KB_MAX_UPLOAD_BYTES={max_bytes}")
    metadata = payload.get("metadata") or {}
    if not isinstance(metadata, dict):
        raise ValueError("metadata must be an object")
    chunking = payload.get("chunking") or {}
    if not isinstance(chunking, dict):
        raise ValueError("chunking must be an object")

    content_type = payload.get("content_type")
    if content_type is not None:
        if not isinstance(content_type, str):
            raise ValueError("content_type must be a string")
        known = content_type in PARSERS or content_type.startswith("text/")
        if not known:
            raise ValueError(f"unsupported content_type '{content_type}'")

    return {
        "filename": filename,
        "project_id": str(payload.get("project_id") or "default"),
        "raw": raw,
        "content_type": content_type,
        "metadata": metadata,
        "chunking": chunking,
    }


_KNOWN_STATES = {item.value for item in DocumentStatus}


def _ingest_status(record: DocumentRecord) -> IngestStatus:
    state_value = (
        record.status.value if isinstance(record.status, DocumentStatus) else str(record.status)
    )
    return IngestStatus(
        document_id=record.document_id,
        state=state_value if state_value in _KNOWN_STATES else "failed",  # type: ignore[arg-type]
        chunks_indexed=record.chunk_count,
        error_message=record.error_message,
    )


@router_ingest.post("/documents", response_model=IngestStatus, status_code=status.HTTP_202_ACCEPTED)
async def ingest_document(request: Request) -> IngestStatus:
    tenant = await verified_tenant(request)
    settings = request.app.state.settings
    ingestion = request.app.state.ingestion

    try:
        fields = _parse_ingest_payload(await request.body(), settings.KB_MAX_UPLOAD_BYTES)
    except ValueError as error:
        raise _http(400, "AXIOM_VALIDATION_FAILED", str(error)) from error

    project_id = tenant.project_id or fields["project_id"]
    try:
        outcome = ingestion.submit(
            tenant.tenant_id,
            project_id,
            fields["filename"],
            fields["raw"],
            fields["content_type"],
        )
    except Exception as error:  # noqa: BLE001 — quota surface
        if "KB_MAX_DOCS" in str(error):
            raise _http(402, "AXIOM_QUOTA_EXCEEDED", str(error)) from error
        raise _http(400, "AXIOM_VALIDATION_FAILED", str(error)) from error

    # Keep original bytes for failed-document replay (R6); bounded by the
    # upload cap so memory stays predictable in dev mode.
    if outcome.status.value == DocumentStatus.QUEUED.value:
        request.app.state.failed_raw[(tenant.tenant_id, outcome.document_id)] = {
            "raw": fields["raw"],
            "content_type": fields["content_type"],
        }
        request.app.state.background.add_task(
            ingestion.process,
            tenant.tenant_id,
            project_id,
            outcome.document_id,
            fields["raw"],
            fields["content_type"],
        )

    record = ingestion.documents.get(tenant.tenant_id, outcome.document_id)
    return IngestStatus(
        document_id=outcome.document_id,
        state=(record.status.value if record else outcome.status.value),
        chunks_indexed=outcome.chunks_indexed,
    )


@router_ingest.get("/documents/{document_id}", response_model=IngestStatus)
async def get_document(request: Request, document_id: str) -> IngestStatus:
    tenant = await verified_tenant(request)
    record = request.app.state.ingestion.documents.get(tenant.tenant_id, document_id)
    if record is None:
        raise _http(404, "AXIOM_NOT_FOUND", "document not found")
    return _ingest_status(record)


@router_ingest.post(
    "/documents/{document_id}/reprocess",
    response_model=IngestStatus,
    status_code=status.HTTP_202_ACCEPTED,
)
async def reprocess_document(request: Request, document_id: str) -> IngestStatus:
    """R6 reindex tooling: replays stored raw bytes for a failed document."""
    tenant = await verified_tenant(request)
    ingestion = request.app.state.ingestion
    record = ingestion.documents.get(tenant.tenant_id, document_id)
    if record is None:
        raise _http(404, "AXIOM_NOT_FOUND", "document not found")
    raw_store = request.app.state.failed_raw
    stored = raw_store.get((tenant.tenant_id, document_id))
    if stored is None:
        raise _http(
            409,
            "AXIOM_CONFLICT",
            "original bytes no longer available; resubmit the document",
        )
    request.app.state.retrieval.invalidate_document(tenant.tenant_id, document_id)
    request.app.state.background.add_task(
        ingestion.process,
        tenant.tenant_id,
        record.project_id,
        document_id,
        stored["raw"],
        stored["content_type"],
    )
    return IngestStatus(document_id=document_id, state="queued", chunks_indexed=0)


@router_ingest.delete("/documents/{document_id}")
async def delete_document(request: Request, document_id: str) -> dict:
    tenant = await verified_tenant(request)
    ingestion = request.app.state.ingestion
    record = ingestion.documents.get(tenant.tenant_id, document_id)
    if record is None:
        raise _http(404, "AXIOM_NOT_FOUND", "document not found")
    removed_vectors = ingestion.vectors.delete_document(
        __import__("app.core.vectorstore", fromlist=["scope_for"]).scope_for(
            request.app.state.settings, tenant.tenant_id
        ),
        document_id,
    )
    ingestion.documents.update_status(
        tenant.tenant_id, document_id, DocumentStatus.FAILED, 0, "deleted"
    )
    request.app.state.retrieval.invalidate_document(tenant.tenant_id, document_id)
    request.app.state.failed_raw.pop((tenant.tenant_id, document_id), None)
    return {"deleted": True, "vectors_removed": max(removed_vectors, 0)}


@router_retrieve.post("/retrieve", response_model=RetrieveResponse)
async def retrieve(request: Request, payload: RetrieveRequest) -> RetrieveResponse:
    tenant = await verified_tenant(request)
    service = request.app.state.retrieval
    result = await service.retrieve(
        tenant_id=tenant.tenant_id,
        project_id=tenant.project_id or "default",
        query=payload.query,
        top_k=payload.top_k,
        score_threshold=payload.score_threshold,
        use_cache=payload.use_cache,
    )
    if not result.served_from_cache:
        service.remember(
            tenant_id=tenant.tenant_id,
            project_id=tenant.project_id or "default",
            query=payload.query,
            top_k=payload.top_k,
            result=result,
        )
    return RetrieveResponse(chunks=result.chunks, served_from_cache=result.served_from_cache)


@router_retrieve.delete("/cache/documents/{document_id}")
async def invalidate_cache(request: Request, document_id: str) -> dict:
    tenant = await verified_tenant(request)
    removed = request.app.state.retrieval.invalidate_document(tenant.tenant_id, document_id)
    return {"invalidated": max(removed, 0)}
