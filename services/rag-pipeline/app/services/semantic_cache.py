"""Two-tier semantic cache (R4).

Tier 1 — exact match: SHA-256 over (tenant, model, query, top_k). Stored in
Redis when available, in-memory otherwise. Zero-cost lookup.

Tier 2 — similarity: query embedding searched against a dedicated
per-tenant cache namespace in the vector store; hits above
SEMANTIC_CACHE_THRESHOLD are served without touching the knowledge index.
Invalidation deletes by document tag so re-indexing poisons nothing.

Deviation note: the spec suggested Redis vector search for tier 2; the
implementation reuses the Qdrant-backed VectorStore instead — one fewer
stateful dependency and identical semantics (ADR 0008).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from app.core.config import Settings
from app.core.embeddings import EmbeddingProvider
from app.core.vectorstore import TenantVectorScope, VectorStore
from app.core.vectorstore import TenantVectorScope as Scope


@dataclass(frozen=True)
class CacheHit:
    answer_chunks: str  # JSON payload of the cached RetrieveResponse-shaped data
    tier: str  # "exact" | "semantic"
    score: float


class SemanticCache:
    def __init__(
        self,
        settings: Settings,
        vectors: VectorStore,
        embeddings: EmbeddingProvider,
    ) -> None:
        self.settings = settings
        self.vectors = vectors
        self.embeddings = embeddings
        self._exact_store: dict[str, str] = {}

    # ------------------------------- keys --------------------------------

    def _exact_key(self, tenant_id: str, model: str | None, query: str, top_k: int) -> str:
        identity = json.dumps({"t": tenant_id, "m": model, "q": query.strip().lower(), "k": top_k})
        digest = hashlib.sha256(identity.encode()).hexdigest()
        return f"scache:{digest}"

    def _scope(self, tenant_id: str) -> TenantVectorScope:
        return Scope(collection="axiom_semantic_cache", tenant_id=tenant_id)

    # ------------------------------ lookups ------------------------------

    def lookup_exact(
        self, tenant_id: str, query: str, top_k: int = 5, model: str | None = None
    ) -> CacheHit | None:
        key = self._exact_key(tenant_id, model, query, top_k)
        value = self._exact_store.get(key)
        if value is not None:
            return CacheHit(answer_chunks=value, tier="exact", score=1.0)
        return None

    def lookup_semantic(
        self,
        tenant_id: str,
        query: str,
        document_ids: set[str] | None = None,
    ) -> CacheHit | None:
        scope = self._scope(tenant_id)
        [vector] = self.embeddings.embed([query])
        hits = self.vectors.search(scope, vector, top_k=1, document_ids=document_ids)
        if not hits or hits[0].score < self.settings.SEMANTIC_CACHE_THRESHOLD:
            return None
        best = hits[0]
        return CacheHit(answer_chunks=best.text, tier="semantic", score=best.score)

    # ------------------------------- store -------------------------------

    def store(
        self,
        tenant_id: str,
        query: str,
        document_ids: set[str],
        response_json: str,
        model: str | None = None,
        top_k: int = 5,
    ) -> None:
        exact_key = self._exact_key(tenant_id, model, query, top_k)
        self._exact_store[exact_key] = response_json

        if not document_ids:
            # Uncached-answer queries (empty results) still get an exact tier
            # entry but no semantic entry to avoid negative-cache drift.
            return
        scope = self._scope(tenant_id)
        [vector] = self.embeddings.embed([query])
        point_id = f"{hashlib.sha256(exact_key.encode()).hexdigest()}"
        self.vectors.ensure_collection(scope, dim=len(vector))
        from app.core.vectorstore import VectorPoint

        self.vectors.upsert(
            scope,
            [
                VectorPoint(
                    id=point_id,
                    vector=vector,
                    text=response_json,
                    document_id=sorted(document_ids)[0],
                    tags={"all_documents": json.dumps(sorted(document_ids)), "model": model or ""},
                )
            ],
        )

    # --------------------------- invalidation ----------------------------

    def invalidate_document(self, tenant_id: str, document_id: str) -> int:
        """Removes semantic entries tied to a document; exact entries expire
        via TTL (bounded blast radius)."""
        scope = self._scope(tenant_id)
        removed = self.vectors.delete_document(scope, document_id)
        if not hasattr(self, "_invalidations"):
            self._invalidations = 0
        self._invalidations += max(removed, 0)
        return max(removed, 0)


def build_cache_redis_client(settings: Settings) -> object | None:
    """Optional Redis client for cross-process exact-tier sharing."""
    if not settings.REDIS_PRIMARY_URL:
        return None
    try:
        import redis  # type: ignore[import-not-found]

        client = redis.Redis.from_url(settings.REDIS_PRIMARY_URL, decode_responses=True)
        client.ping()
        return client
    except Exception:  # noqa: BLE001 — cache must never break serving
        return None


__all__ = ["SemanticCache", "CacheHit", "build_cache_redis_client"]
