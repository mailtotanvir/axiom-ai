"""Ingestion pipeline service (R1/R6): parse → chunk → embed → index with
durable statuses, content-hash dedupe, quota accounting, and reprocessing.

Execution is inline via FastAPI background tasks for v1 (single container);
the Celery topology in app/workers remains the scale-out path.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.chunking import chunk_text
from app.core.config import Settings
from app.core.documents import (
    DocumentRecord,
    DocumentStatus,
    DocumentStore,
    content_hash,
    new_document_id,
)
from app.core.embeddings import EmbeddingProvider
from app.core.guardrails import redact_pii
from app.core.parsers import parse_document
from app.core.vectorstore import TenantVectorScope, VectorPoint, VectorStore, scope_for


class QuotaExceededError(Exception):
    pass


@dataclass(frozen=True)
class IngestOutcome:
    document_id: str
    status: DocumentStatus
    deduplicated: bool
    chunks_indexed: int
    error_message: str | None = None


class IngestionService:
    def __init__(
        self,
        settings: Settings,
        documents: DocumentStore,
        vectors: VectorStore,
        embeddings: EmbeddingProvider,
    ) -> None:
        self.settings = settings
        self.documents = documents
        self.vectors = vectors
        self.embeddings = embeddings
        self._pending_content_type: dict[tuple[str, str], str] = {}

    def submit(
        self,
        tenant_id: str,
        project_id: str,
        filename: str,
        raw: bytes,
        content_type: str | None = None,
    ) -> IngestOutcome:
        """Registers a document and returns immediately; processing runs as a
        background task. Dedupe and quota checks are synchronous."""
        digest = content_hash(tenant_id, project_id, raw)

        existing = self.documents.find_by_content(tenant_id, project_id, digest)
        if existing is not None:
            return IngestOutcome(
                document_id=existing.document_id,
                status=existing.status,
                deduplicated=True,
                chunks_indexed=existing.chunk_count,
            )

        if self.documents.count_for_tenant(tenant_id) >= self.settings.KB_MAX_DOCS_PER_TENANT:
            raise QuotaExceededError(
                f"tenant '{tenant_id}' reached KB_MAX_DOCS_PER_TENANT="
                f"{self.settings.KB_MAX_DOCS_PER_TENANT}"
            )

        # Deterministic id: re-ingesting after deletion maps to the same id.
        document_id = new_document_id(tenant_id, digest)
        record = self.documents.create(
            DocumentRecord(
                document_id=document_id,
                tenant_id=tenant_id,
                project_id=project_id,
                content_hash=digest,
                status=DocumentStatus.QUEUED,
            )
        )
        self._pending_content_type[(tenant_id, record.document_id)] = (
            content_type or _content_type_of(raw, filename)
        )
        return IngestOutcome(
            document_id=record.document_id,
            status=record.status,
            deduplicated=False,
            chunks_indexed=0,
        )

    def process(
        self,
        tenant_id: str,
        project_id: str,
        document_id: str,
        raw: bytes,
        content_type: str | None = None,
    ) -> None:
        """Runs the full pipeline; every transition persists so failures are
        visible and reprocessable (R6)."""
        scope = scope_for(self.settings, tenant_id)
        resolved_type = (
            content_type
            or self._pending_content_type.pop((tenant_id, document_id), None)
            or _content_type_of(raw, filename=document_id)
        )

        def fail(message: str) -> None:
            self.documents.update_status(
                tenant_id, document_id, DocumentStatus.FAILED, 0, message[:512]
            )

        try:
            self.documents.update_status(tenant_id, document_id, DocumentStatus.PARSING)
            parsed = parse_document(resolved_type, raw)
            sanitized_text, _ = redact_pii(parsed.text, tenant_id=tenant_id)

            self.documents.update_status(tenant_id, document_id, DocumentStatus.CHUNKING)
            chunks = chunk_text(sanitized_text, strategy=_strategy_for(document_id))

            self.documents.update_status(tenant_id, document_id, DocumentStatus.EMBEDDING)
            vectors = self.embeddings.embed([chunk.text for chunk in chunks])
            points = [
                VectorPoint(
                    id=f"{document_id}:{chunk.ordinal}",
                    vector=vector,
                    text=chunk.text[:4_096],
                    document_id=document_id,
                    tags={
                        "ordinal": str(chunk.ordinal),
                        "parser": parsed.parser,
                        "start_offset": str(chunk.start_offset),
                        "end_offset": str(chunk.end_offset),
                    },
                )
                for chunk, vector in zip(chunks, vectors, strict=True)
            ]
            dim = len(vectors[0]) if vectors else self.settings.EMBEDDING_DIM
            self.vectors.ensure_collection(scope, dim=dim)

            # Replace-on-success: old points for this id go first so failed
            # reingests never leave mixed versions.
            self.vectors.delete_document(scope, document_id)
            if points:
                self.vectors.upsert(scope, points)

            self.documents.update_status(
                tenant_id, document_id, DocumentStatus.INDEXED, chunk_count=len(points)
            )
        except Exception as error:  # noqa: BLE001 — dead-letter surface (R6)
            fail(f"ingestion failed: {error}")

    def delete_document(self, tenant_id: str, document_id: str) -> bool:
        record = self.documents.get(tenant_id, document_id)
        if record is None:
            return False
        scope: TenantVectorScope = scope_for(self.settings, tenant_id)
        self.vectors.delete_document(scope, document_id)
        self.documents.update_status(tenant_id, document_id, DocumentStatus.FAILED, 0, "deleted")
        return True


def _content_type_of(raw: bytes, filename: str = "") -> str:
    """Sniffs a minimal content-type set from magic bytes/filename hints."""
    if raw.startswith(b"%PDF") or filename.lower().endswith(".pdf"):
        return "application/pdf"
    if filename.lower().endswith((".md", ".markdown")):
        return "text/markdown"
    if filename.lower().endswith((".html", ".htm")):
        return "text/html"
    return "text/plain"


def _strategy_for(document_id: str) -> str:
    # Markdown-aware splitting is safe for all text sources; layout-aware
    # PDF refinement lands with the Unstructured extra.
    return "markdown"


__all__ = ["IngestionService", "IngestOutcome", "QuotaExceededError"]
