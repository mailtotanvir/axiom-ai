"""Vector store abstraction (R2, ADR 0004).

Tenant scoping is structural: every call takes a TenantScope derived from
verified request credentials, and implementations MUST apply it as a
server-side filter. Callers can never inject tenant filters into queries.

Two implementations: an in-memory store for tests/dev, and Qdrant via its
REST API (no client SDK dependency).
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import httpx

from app.core.config import Settings


@dataclass(frozen=True)
class TenantVectorScope:
    """Derived from verified credentials — never from caller input."""

    collection: str
    tenant_id: str


def scope_for(settings: Settings, tenant_id: str) -> TenantVectorScope:
    """Collection-per-tenant-class naming convention (spec row 8)."""
    return TenantVectorScope(collection="axiom_knowledge", tenant_id=tenant_id)


@dataclass(frozen=True)
class VectorPoint:
    id: str
    vector: list[float]
    text: str
    document_id: str
    tags: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SearchHit:
    id: str
    score: float
    text: str
    document_id: str
    tags: dict[str, str]


class VectorStore(ABC):
    @abstractmethod
    def ensure_collection(self, scope: TenantVectorScope, dim: int) -> None: ...

    @abstractmethod
    def upsert(self, scope: TenantVectorScope, points: list[VectorPoint]) -> None: ...

    @abstractmethod
    def search(
        self,
        scope: TenantVectorScope,
        vector: list[float],
        top_k: int,
        document_ids: set[str] | None = None,
    ) -> list[SearchHit]: ...

    @abstractmethod
    def delete_document(self, scope: TenantVectorScope, document_id: str) -> int: ...


class InMemoryVectorStore(VectorStore):
    """Deterministic store used by unit/integration tests."""

    def __init__(self) -> None:
        # (collection, tenant) -> {point_id: VectorPoint}
        self._data: dict[tuple[str, str], dict[str, VectorPoint]] = {}
        self.collections: set[tuple[str, int]] = set()

    @staticmethod
    def _key(scope: TenantVectorScope) -> tuple[str, str]:
        return (scope.collection, scope.tenant_id)

    def ensure_collection(self, scope: TenantVectorScope, dim: int) -> None:
        self.collections.add((scope.collection, dim))
        self._data.setdefault(self._key(scope), {})

    def upsert(self, scope: TenantVectorScope, points: list[VectorPoint]) -> None:
        bucket = self._data.setdefault(self._key(scope), {})
        for point in points:
            bucket[point.id] = point

    def search(
        self,
        scope: TenantVectorScope,
        vector: list[float],
        top_k: int,
        document_ids: set[str] | None = None,
    ) -> list[SearchHit]:
        bucket = self._data.get(self._key(scope), {})
        scored: list[tuple[float, VectorPoint]] = []
        for point in bucket.values():
            if document_ids is not None and point.document_id not in document_ids:
                continue
            score = _cosine(vector, point.vector)
            scored.append((score, point))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [
            SearchHit(id=p.id, score=s, text=p.text, document_id=p.document_id, tags=p.tags)
            for s, p in scored[:top_k]
        ]

    def delete_document(self, scope: TenantVectorScope, document_id: str) -> int:
        bucket = self._data.get(self._key(scope), {})
        victims = [pid for pid, p in bucket.items() if p.document_id == document_id]
        for pid in victims:
            del bucket[pid]
        return len(victims)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class QdrantRestVectorStore(VectorStore):
    """Qdrant via REST. The tenant claim rides as a mandatory payload filter;
    a missing/mismatched filter simply matches nothing outside the tenant."""

    def __init__(self, base_url: str, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=30)

    def ensure_collection(self, scope: TenantVectorScope, dim: int) -> None:
        response = self._client.put(
            f"{self.base_url}/collections/{scope.collection}",
            json={"vectors": {"size": dim, "distance": "Cosine"}},
        )
        if response.status_code not in (200, 409):
            response.raise_for_status()

    def upsert(self, scope: TenantVectorScope, points: list[VectorPoint]) -> None:
        response = self._client.put(
            f"{self.base_url}/collections/{scope.collection}/points",
            params={"wait": "true"},
            json={
                "points": [
                    {
                        "id": _uuid5_int(point.id),
                        "vector": point.vector,
                        "payload": {
                            "text": point.text,
                            "document_id": point.document_id,
                            "tenant_id": scope.tenant_id,
                            **point.tags,
                        },
                    }
                    for point in points
                ]
            },
        )
        response.raise_for_status()

    def search(
        self,
        scope: TenantVectorScope,
        vector: list[float],
        top_k: int,
        document_ids: set[str] | None = None,
    ) -> list[SearchHit]:
        must: list[dict[str, object]] = [{"key": "tenant_id", "match": {"value": scope.tenant_id}}]
        if document_ids is not None:
            must.append({"key": "document_id", "match": {"any": sorted(document_ids)}})
        url = f"{self.base_url}/collections/{scope.collection}/points/search"
        response = self._client.post(
            url,
            json={
                "vector": vector,
                "limit": top_k,
                "with_payload": True,
                "filter": {"must": must},
            },
        )
        response.raise_for_status()
        hits: list[SearchHit] = []
        for row in response.json().get("result", []):
            payload = row.get("payload", {})
            skip = ("text", "document_id", "tenant_id")
            tags = {k: str(v) for k, v in payload.items() if k not in skip}
            hits.append(
                SearchHit(
                    id=str(row["id"]),
                    score=float(row["score"]),
                    text=str(payload.get("text", "")),
                    document_id=str(payload.get("document_id", "")),
                    tags=tags,
                )
            )
        return hits

    def delete_document(self, scope: TenantVectorScope, document_id: str) -> int:
        url = f"{self.base_url}/collections/{scope.collection}/points/delete"
        response = self._client.post(
            url,
            params={"wait": "true"},
            json={
                "filter": {
                    "must": [
                        {"key": "tenant_id", "match": {"value": scope.tenant_id}},
                        {"key": "document_id", "match": {"value": document_id}},
                    ]
                }
            },
        )
        response.raise_for_status()
        # Qdrant does not report counts on filter deletes; callers treat
        # this as best-effort cleanup.
        return -1


def _uuid5_int(name: str) -> str:
    """Deterministic UUIDv5-formatted id from a string key (Qdrant needs UUIDs)."""
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, name))
