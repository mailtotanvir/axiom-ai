"""Document metadata store (R1/R6): statuses, content-hash dedupe,
dead-letter tracking, and reprocessing support. Postgres when configured;
in-memory otherwise."""

from __future__ import annotations

import abc
import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

from app.core.config import Settings


class DocumentStatus(StrEnum):
    QUEUED = "queued"
    PARSING = "parsing"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXED = "indexed"
    FAILED = "failed"


@dataclass
class DocumentRecord:
    document_id: str
    tenant_id: str
    project_id: str
    content_hash: str
    status: DocumentStatus
    chunk_count: int = 0
    error_message: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


def content_hash(tenant_id: str, project_id: str, raw: bytes) -> str:
    return hashlib.sha256(f"{tenant_id}:{project_id}:".encode() + raw).hexdigest()


def new_document_id(tenant_id: str, content_hash_hex: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{tenant_id}:{content_hash_hex}"))


class DocumentStore(abc.ABC):
    """Persistence boundary for document metadata."""

    @abc.abstractmethod
    def find_by_content(
        self, tenant_id: str, project_id: str, digest: str
    ) -> DocumentRecord | None: ...

    @abc.abstractmethod
    def count_for_tenant(self, tenant_id: str) -> int: ...

    @abc.abstractmethod
    def create(self, record: DocumentRecord) -> DocumentRecord: ...

    @abc.abstractmethod
    def get(self, tenant_id: str, document_id: str) -> DocumentRecord | None: ...

    @abc.abstractmethod
    def update_status(
        self,
        tenant_id: str,
        document_id: str,
        status: DocumentStatus,
        chunk_count: int | None = None,
        error_message: str | None = None,
    ) -> DocumentRecord | None: ...


class InMemoryDocumentStore(DocumentStore):
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], DocumentRecord] = {}

    def find_by_content(
        self, tenant_id: str, project_id: str, digest: str
    ) -> DocumentRecord | None:
        for record in self._records.values():
            if record.tenant_id == tenant_id and record.content_hash == digest:
                return record
        return None

    def count_for_tenant(self, tenant_id: str) -> int:
        return sum(1 for r in self._records.values() if r.tenant_id == tenant_id)

    def create(self, record: DocumentRecord) -> DocumentRecord:
        self._records[(record.tenant_id, record.document_id)] = record
        return record

    def get(self, tenant_id: str, document_id: str) -> DocumentRecord | None:
        return self._records.get((tenant_id, document_id))

    def update_status(
        self,
        tenant_id: str,
        document_id: str,
        status: DocumentStatus,
        chunk_count: int | None = None,
        error_message: str | None = None,
    ) -> DocumentRecord | None:
        record = self._records.get((tenant_id, document_id))
        if record is None:
            return None
        record.status = status
        if chunk_count is not None:
            record.chunk_count = chunk_count
        record.error_message = error_message
        record.updated_at = datetime.now(UTC).isoformat()
        return record


class PostgresDocumentStore(DocumentStore):
    def __init__(self, connection_string: str) -> None:
        from psycopg_pool import ConnectionPool

        self._pool = ConnectionPool(conninfo=connection_string, max_size=4, open=True)
        self._migrate()

    def _migrate(self) -> None:
        with self._pool.connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS kb_documents (
                    document_id   TEXT NOT NULL,
                    tenant_id     TEXT NOT NULL,
                    project_id    TEXT NOT NULL,
                    content_hash  TEXT NOT NULL,
                    status        TEXT NOT NULL,
                    chunk_count   INTEGER NOT NULL DEFAULT 0,
                    error_message TEXT,
                    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                    PRIMARY KEY (tenant_id, document_id)
                )
                """
            )
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_dedupe_idx "
                "ON kb_documents (tenant_id, content_hash)"
            )

    def find_by_content(
        self, tenant_id: str, project_id: str, digest: str
    ) -> DocumentRecord | None:
        with self._pool.connection() as conn:
            query = (
                "SELECT document_id, project_id, content_hash, status, chunk_count, "
                "error_message, created_at, updated_at FROM kb_documents "
                "WHERE tenant_id=%s AND content_hash=%s"
            )
            row = conn.execute(query, (tenant_id, digest)).fetchone()
        return self._row_to_record(tenant_id, row)

    def count_for_tenant(self, tenant_id: str) -> int:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT count(*) FROM kb_documents WHERE tenant_id=%s", (tenant_id,)
            ).fetchone()
        return int(row[0]) if row else 0

    def create(self, record: DocumentRecord) -> DocumentRecord:
        with self._pool.connection() as conn:
            conn.execute(
                "INSERT INTO kb_documents"
                " (document_id, tenant_id, project_id, content_hash,"
                " status, chunk_count, error_message, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)"
                " ON CONFLICT (tenant_id, document_id) DO NOTHING",
                (
                    record.document_id,
                    record.tenant_id,
                    record.project_id,
                    record.content_hash,
                    record.status.value,
                    record.chunk_count,
                    record.error_message,
                    record.created_at,
                    record.updated_at,
                ),
            )
        return record

    def get(self, tenant_id: str, document_id: str) -> DocumentRecord | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "SELECT document_id, project_id, content_hash, status,"
                " chunk_count, error_message, created_at, updated_at"
                " FROM kb_documents WHERE tenant_id=%s AND document_id=%s",
                (tenant_id, document_id),
            ).fetchone()
        return self._row_to_record(tenant_id, row)

    def update_status(
        self,
        tenant_id: str,
        document_id: str,
        status: DocumentStatus,
        chunk_count: int | None = None,
        error_message: str | None = None,
    ) -> DocumentRecord | None:
        with self._pool.connection() as conn:
            row = conn.execute(
                "UPDATE kb_documents SET status=%s,"
                " chunk_count=COALESCE(%s, chunk_count),"
                " error_message=%s, updated_at=now()"
                " WHERE tenant_id=%s AND document_id=%s"
                " RETURNING project_id, content_hash,"
                " chunk_count, error_message, created_at, updated_at",
                (status.value, chunk_count, error_message, tenant_id, document_id),
            ).fetchone()
        if row is None:
            return None
        project_id, digest = row[0], row[1]
        return DocumentRecord(
            document_id=document_id,
            tenant_id=tenant_id,
            project_id=str(project_id),
            content_hash=str(digest),
            status=status,
            chunk_count=int(row[2]),
            error_message=row[3],
            created_at=row[4].isoformat() if row[4] else "",
            updated_at=row[5].isoformat() if row[5] else "",
        )

    @staticmethod
    def _row_to_document(tenant_id: str, row: tuple) -> DocumentRecord:
        return DocumentRecord(
            document_id=str(row[0]),
            tenant_id=tenant_id,
            project_id=str(row[1]),
            content_hash=str(row[2]),
            status=DocumentStatus(str(row[3])),
            chunk_count=int(row[4]),
            error_message=row[5],
            created_at=row[6].isoformat() if row[6] else "",
            updated_at=row[7].isoformat() if row[7] else "",
        )

    def _row_to_record(self, tenant_id: str, row: tuple | None) -> DocumentRecord | None:
        if row is None:
            return None
        return self._row_to_document(tenant_id, row)

    def close(self) -> None:
        self._pool.close()


def build_document_store(settings: Settings) -> DocumentStore:
    if settings.POSTGRES_DB_URI:
        return PostgresDocumentStore(settings.POSTGRES_DB_URI)
    return InMemoryDocumentStore()
