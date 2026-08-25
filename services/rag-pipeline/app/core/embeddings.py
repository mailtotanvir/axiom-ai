"""Embedding providers (R2).

- hash (default): deterministic feature-hashing embeddings. No network, no
  model download — makes tests and local dev fully self-contained while
  preserving similarity semantics for identical/near-identical texts.
- openai: any OpenAI-compatible /embeddings endpoint (the Axiom gateway or
  a hosted provider).
- sentence_transformers: optional extra; imported lazily so the base
  install stays light.
"""

from __future__ import annotations

import hashlib
import math
from abc import ABC, abstractmethod

import httpx

from app.core.config import Settings


class EmbeddingProvider(ABC):
    dim: int
    name: str

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """Embeds a batch of texts into unit-normalized vectors."""


class HashEmbeddingProvider(EmbeddingProvider):
    """Feature-hashing embeddings with n-gram buckets.

    Deterministic across processes and platforms. Cosine similarity is
    meaningful: shared word trigrams push vectors together.
    """

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim
        self.name = f"hash-{dim}"

    def _vectorize(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        normalized = text.lower()
        tokens = normalized.split()
        grams = [" ".join(tokens[i : i + 3]) for i in range(max(1, len(tokens) - 2))]
        if not grams:
            grams = [normalized]
        for gram in grams:
            digest = hashlib.sha256(gram.encode("utf-8")).digest()
            bucket = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[bucket] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vectorize(text) for text in texts]


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """Calls an OpenAI-compatible POST /embeddings endpoint."""

    def __init__(
        self,
        api_base: str,
        api_key: str,
        model: str,
        dim: int,
        client: httpx.Client | None = None,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dim = dim
        self.name = f"openai:{model}"
        self._client = client or httpx.Client(timeout=30)

    def embed(self, texts: list[str]) -> list[list[float]]:
        response = self._client.post(
            f"{self.api_base}/embeddings",
            headers={"authorization": f"Bearer {self.api_key}"},
            json={"model": self.model, "input": texts},
        )
        response.raise_for_status()
        payload = response.json()["data"]
        vectors = [item["embedding"] for item in sorted(payload, key=lambda item: item["index"])]
        if len(vectors) != len(texts):
            raise ValueError("embedding endpoint returned mismatched batch size")
        return vectors


class SentenceTransformersProvider(EmbeddingProvider):
    """Local sentence-transformers models (optional extra)."""

    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]

        self._model = SentenceTransformer(model_name)
        self.dim = int(self._model.get_sentence_embedding_dimension())
        self.name = f"st:{model_name}"

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts, normalize_embeddings=True)
        return [list(map(float, vector)) for vector in vectors]


def build_embedding_provider(settings: Settings) -> EmbeddingProvider:
    if settings.EMBEDDING_PROVIDER == "hash":
        return HashEmbeddingProvider(dim=settings.EMBEDDING_DIM)
    if settings.EMBEDDING_PROVIDER == "openai":
        assert settings.EMBEDDING_API_BASE and settings.EMBEDDING_API_KEY  # validated in config
        return OpenAIEmbeddingProvider(
            api_base=settings.EMBEDDING_API_BASE,
            api_key=settings.EMBEDDING_API_KEY,
            model=settings.EMBEDDING_MODEL or "text-embedding-3-small",
            dim=settings.EMBEDDING_DIM,
        )
    if settings.EMBEDDING_PROVIDER == "sentence_transformers":
        return SentenceTransformersProvider(settings.EMBEDDING_MODEL or "all-MiniLM-L6-v2")
    raise ValueError(f"unknown embedding provider '{settings.EMBEDDING_PROVIDER}'")
