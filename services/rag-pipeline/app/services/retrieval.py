"""Retrieval service (R3): cache tiers → dense search → keyword (BM25)
fusion over the candidate set → citations.

Hybrid note: candidates come from dense vector search, then a lightweight
BM25 over candidate payloads fuses signal via Reciprocal Rank Fusion. A
native Qdrant sparse-vector index is the scale-out path and lands with the
Unstructured/fastembed extras.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass

from app.core.config import Settings
from app.core.embeddings import EmbeddingProvider
from app.core.vectorstore import TenantVectorScope as Scope
from app.core.vectorstore import VectorStore, scope_for
from app.services.semantic_cache import SemanticCache

_TOKEN = re.compile(r"[a-z0-9]+")


def tokenize(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


def bm25_scores(
    query_tokens: list[str],
    documents_tokens: list[list[str]],
    k1: float = 1.5,
    b: float = 0.75,
) -> list[float]:
    """Classic Okapi BM25 — pure function, unit-tested."""
    if not documents_tokens:
        return []
    doc_count = len(documents_tokens)
    lengths = [len(d) for d in documents_tokens]
    avg_len = (sum(lengths) / doc_count) or 1.0
    df: Counter[str] = Counter()
    for tokens in documents_tokens:
        df.update(set(tokens))

    scores: list[float] = []
    for tokens, length in zip(documents_tokens, lengths, strict=True):
        counts = Counter(tokens)
        score = 0.0
        for term in query_tokens:
            if term not in counts:
                continue
            idf = math.log(1 + (doc_count - df[term] + 0.5) / (df[term] + 0.5))
            tf = counts[term]
            denom = tf + k1 * (1 - b + b * length / avg_len)
            score += idf * (tf * (k1 + 1)) / denom
        scores.append(score)
    return scores


def reciprocal_rank_fusion(
    *rankings: list[str],
    k: int = 60,
) -> list[str]:
    """RRF over id lists — pure function, unit-tested."""
    fused: dict[str, float] = {}
    for ranking in rankings:
        for position, item in enumerate(ranking):
            fused[item] = fused.get(item, 0.0) + 1.0 / (k + position + 1)
    return [item for item, _ in sorted(fused.items(), key=lambda kv: kv[1], reverse=True)]


@dataclass(frozen=True)
class RetrievalResult:
    chunks: list[dict[str, object]]
    served_from_cache: bool
    cache_tier: str | None


class RetrievalService:
    def __init__(
        self,
        settings: Settings,
        vectors: VectorStore,
        embeddings: EmbeddingProvider,
        cache: SemanticCache,
    ) -> None:
        self.settings = settings
        self.vectors = vectors
        self.embeddings = embeddings
        self.cache = cache

    async def retrieve(
        self,
        tenant_id: str,
        project_id: str,
        query: str,
        top_k: int = 5,
        score_threshold: float | None = None,
        use_cache: bool = True,
        model: str | None = None,
    ) -> RetrievalResult:
        # ------------------------------ cache ------------------------------
        if use_cache:
            hit = self.cache.lookup_exact(tenant_id, query, top_k, model)
            if hit is None:
                hit = self.cache.lookup_semantic(tenant_id, query)
            if hit is not None:
                payload = json.loads(hit.answer_chunks)
                return RetrievalResult(
                    chunks=payload.get("chunks", []),
                    served_from_cache=True,
                    cache_tier=hit.tier,
                )

        # ----------------------------- dense --------------------------------
        scope: Scope = scope_for(self.settings, tenant_id)
        [query_vector] = self.embeddings.embed([query])
        candidates = max(self.settings.RETRIEVAL_CANDIDATES, top_k * 4)
        hits = self.vectors.search(scope, query_vector, top_k=candidates)

        # --------------------------- hybrid fuse ----------------------------
        query_tokens = tokenize(query)
        docs_tokens = [tokenize(hit.text) for hit in hits]
        keyword_ranking = [
            hits[i].id
            for i in sorted(
                range(len(hits)),
                key=lambda i: bm25_scores(query_tokens, docs_tokens)[i],
                reverse=True,
            )
        ]
        dense_ranking = [hit.id for hit in hits]
        fused_ids = set(reciprocal_rank_fusion(dense_ranking, keyword_ranking)[:top_k])

        by_id = {candidate.id: candidate for candidate in hits}
        results: list[dict[str, object]] = []
        for hit_id in reciprocal_rank_fusion(dense_ranking, keyword_ranking):
            if len(results) >= top_k:
                break
            if hit_id not in fused_ids:
                continue
            vector_hit = by_id[hit_id]
            if score_threshold is not None and vector_hit.score < score_threshold:
                continue
            tags = dict(vector_hit.tags)
            results.append(
                {
                    "chunk_id": vector_hit.id,
                    "document_id": vector_hit.document_id,
                    "score": round(vector_hit.score, 6),
                    "text": vector_hit.text,
                    "metadata": {
                        "ordinal": tags.get("ordinal", ""),
                        "parser": tags.get("parser", ""),
                        "source_span": {
                            "start_offset": int(tags.get("start_offset", 0)),
                            "end_offset": int(tags.get("end_offset", 0)),
                        },
                    },
                }
            )

        return RetrievalResult(chunks=results, served_from_cache=False, cache_tier=None)

    def remember(
        self,
        tenant_id: str,
        project_id: str,
        query: str,
        top_k: int,
        result: RetrievalResult,
        model: str | None = None,
    ) -> None:
        if result.served_from_cache or not result.chunks:
            return
        document_ids = {str(chunk["document_id"]) for chunk in result.chunks}
        self.cache.store(
            tenant_id=tenant_id,
            query=query,
            document_ids=document_ids,
            response_json=json.dumps({"chunks": result.chunks}),
            model=model,
            top_k=top_k,
        )

    def invalidate_document(self, tenant_id: str, document_id: str) -> int:
        return self.cache.invalidate_document(tenant_id, document_id)
