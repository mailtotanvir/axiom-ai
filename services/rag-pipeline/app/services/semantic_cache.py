"""Semantic cache interface over Redis vector search (Phase 2, epic R4)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CacheEntry:
    answer: str
    similarity: float


class SemanticCache(Protocol):
    async def lookup(self, tenant_id: str, query_embedding: list[float]) -> CacheEntry | None: ...

    async def store(
        self,
        tenant_id: str,
        query_embedding: list[float],
        answer: str,
    ) -> None: ...

    async def invalidate_document(self, tenant_id: str, document_id: str) -> int: ...


class NullSemanticCache:
    """Phase 0 no-op implementation; Redis vector search lands with R4."""

    async def lookup(
        self, tenant_id: str, query_embedding: list[float]
    ) -> CacheEntry | None:
        return None

    async def store(
        self, tenant_id: str, query_embedding: list[float], answer: str
    ) -> None:
        return None

    async def invalidate_document(self, tenant_id: str, document_id: str) -> int:
        return 0
