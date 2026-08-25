"""Embedding providers (R2), semantic cache tiers (R4), and retrieval
fusion/citation behaviour (R3)."""

import httpx
import pytest

from app.core.config import Settings
from app.core.embeddings import (
    HashEmbeddingProvider,
    OpenAIEmbeddingProvider,
    build_embedding_provider,
)
from app.core.vectorstore import InMemoryVectorStore, VectorPoint
from app.services.retrieval import bm25_scores, reciprocal_rank_fusion
from app.services.semantic_cache import SemanticCache


def settings(**overrides) -> Settings:
    values = {
        "AXIOM_ENV": "test",
        "EMBEDDING_DIM": 64,
        # Hash embeddings are sparser than neural ones; thresholds must be
        # tuned per provider (production default 0.92 targets neural models).
        "SEMANTIC_CACHE_THRESHOLD": 0.5,
    }
    values.update(overrides)
    return Settings(**values)


class TestHashEmbeddings:
    def test_deterministic_and_normalized(self) -> None:
        provider = HashEmbeddingProvider(dim=64)
        first = provider.embed(["hello world"])[0]
        second = provider.embed(["hello world"])[0]
        assert first == second
        norm = sum(v * v for v in first) ** 0.5
        assert norm == pytest.approx(1.0, abs=1e-6)

    def test_identical_texts_have_max_similarity(self) -> None:
        provider = HashEmbeddingProvider(dim=64)
        [a] = provider.embed(["the refund policy allows returns"])
        [b] = provider.embed(["the refund policy allows returns"])
        cosine = sum(x * y for x, y in zip(a, b, strict=True))
        assert cosine == pytest.approx(1.0)

    def test_disjoint_texts_are_far_apart(self) -> None:
        provider = HashEmbeddingProvider(dim=64)
        [a] = provider.embed(["quantum flux capacitor calibration"])
        [b] = provider.embed(["banana strawberry smoothie recipe"])
        cosine = sum(x * y for x, y in zip(a, b, strict=True))
        assert cosine < 0.5


class TestOpenAICompatibleEmbeddings:
    def test_calls_endpoint_and_preserves_order(self) -> None:
        calls: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            import json

            calls.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": 1, "embedding": [0.0, 1.0]},
                        {"index": 0, "embedding": [1.0, 0.0]},
                    ]
                },
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        provider = OpenAIEmbeddingProvider(
            api_base="http://embedder.test/v1",
            api_key="key",
            model="text-embedding-test",
            dim=2,
            client=client,
        )
        vectors = provider.embed(["first", "second"])
        assert vectors[0] == [1.0, 0.0]
        assert vectors[1] == [0.0, 1.0]
        assert calls[0]["model"] == "text-embedding-test"


def test_factory_builds_expected_provider() -> None:
    provider = build_embedding_provider(settings())
    assert isinstance(provider, HashEmbeddingProvider)


# ------------------------------ R4 semantic cache ------------------------------


@pytest.fixture()
def cache_stack() -> tuple[SemanticCache, InMemoryVectorStore]:
    cfg = settings()
    vectors = InMemoryVectorStore()
    embeddings = HashEmbeddingProvider(dim=cfg.EMBEDDING_DIM)
    return SemanticCache(cfg, vectors, embeddings), vectors


class TestSemanticCache:
    def test_exact_tier_round_trip(self, cache_stack) -> None:
        cache, _ = cache_stack
        cache.store("t1", "what is the refund window?", {"d1"}, '{"chunks":[{"x":1}]}')
        hit = cache.lookup_exact("t1", "What is the refund window?", top_k=5)
        assert hit is not None
        assert hit.tier == "exact"

    def test_semantic_tier_hits_above_threshold(self, cache_stack) -> None:
        cache, _ = cache_stack
        query = "employees receive paid vacation weeks"
        cache.store("t1", query, {"d1"}, '{"chunks":[{"text":"vacation"}]}')
        # Same core phrasing plus an extension shares most word trigrams.
        near = "employees receive paid vacation weeks per year"
        hit = cache.lookup_semantic("t1", near)
        assert hit is not None
        assert hit.tier == "semantic"

    def test_unrelated_query_misses_semantic_tier(self, cache_stack) -> None:
        cache, _ = cache_stack
        cache.store("t1", "quantum capacitor calibration", {"d1"}, "{}")
        assert cache.lookup_semantic("t1", "banana smoothie recipe") is None

    def test_tenants_do_not_share_entries(self, cache_stack) -> None:
        cache, _ = cache_stack
        cache.store("tenant-a", "shared question", {"d1"}, '{"a":true}')
        assert cache.lookup_exact("tenant-b", "shared question") is None

    def test_invalidate_document_removes_semantic_entry(self, cache_stack) -> None:
        cache, vectors = cache_stack
        cache.store("t1", "vacation policy details", {"doc-9"}, '{"chunks":[]}')
        removed = cache.invalidate_document("t1", "doc-9")
        assert removed >= 1
        assert cache.lookup_semantic("t1", "vacation policy details") is None


# ------------------------------ R3 fusion / citations ------------------------------


class TestFusion:
    def test_bm25_ranks_relevant_document_first(self) -> None:
        docs_tokens = [
            ["refund", "policy", "allows", "returns"],
            ["vacation", "days", "for", "employees"],
        ]
        scores = bm25_scores(["refund", "returns"], docs_tokens)
        assert scores[0] > scores[1]

    def test_rrf_prefers_items_ranked_high_in_both_lists(self) -> None:
        fused = reciprocal_rank_fusion(
            ["a", "b", "c"],
            ["b", "a", "c"],
        )
        assert fused[0] in ("a", "b")
        assert fused[-1] == "c"


class TestRetrievalCitations:
    def test_results_carry_document_and_chunk_citations(self) -> None:
        from app.services.retrieval import RetrievalService

        cfg = settings()
        vectors = InMemoryVectorStore()
        embeddings = HashEmbeddingProvider(dim=cfg.EMBEDDING_DIM)
        scope_vectors = vectors

        service = RetrievalService(
            cfg, vectors, embeddings, SemanticCache(cfg, vectors, embeddings)
        )

        # Seed directly through the store to isolate citation shaping.
        scope_vectors.ensure_collection.__self__  # noqa: B018 — ensure via upsert below
        points = [
            VectorPoint(
                id=f"doc-1:{i}",
                vector=embeddings.embed([text])[0],
                text=text,
                document_id="doc-1",
                tags={"ordinal": str(i)},
            )
            for i, text in enumerate(
                ["The refund policy allows 30-day returns.", "Unrelated banana content."]
            )
        ]
        from app.core.vectorstore import scope_for
        from tests.conftest import make_settings as _ts  # local to avoid cycles

        scope = scope_for(_ts(), "tenant-c")
        scope_vectors.upsert(scope, points)

        result = __import__("anyio").run(
            lambda: service.retrieve(
                tenant_id="tenant-c",
                project_id="proj",
                query="refund policy",
                top_k=5,
                use_cache=False,
            )
        )
        assert result.chunks
        top = result.chunks[0]
        assert top["document_id"] == "doc-1"
        assert top["chunk_id"].startswith("doc-1:")
        assert "source_span" in top["metadata"]
