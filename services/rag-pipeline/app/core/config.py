"""Configuration contract for the RAG pipeline.

Mirrors the shared environment contract enforced by @axiom-ai/core (spec
section 5). Services must never read os.environ at call sites; everything
flows through Settings.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    AXIOM_ENV: Literal["development", "test", "staging", "production"] = "development"
    AXIOM_INTER_SERVICE_SECRET: str = Field(default="dev-only-inter-service-secret")

    REDIS_PRIMARY_URL: str | None = None
    POSTGRES_DB_URI: str | None = None
    QDRANT_URL: str = "http://localhost:6333"

    # Embeddings: "hash" is dependency-free and deterministic (dev/tests);
    # "openai" calls any OpenAI-compatible /embeddings endpoint (gateway or
    # hosted); "sentence_transformers" uses local models when installed.
    EMBEDDING_PROVIDER: Literal["hash", "openai", "sentence_transformers"] = "hash"
    EMBEDDING_DIM: int = 256
    EMBEDDING_MODEL: str | None = None
    EMBEDDING_API_BASE: str | None = None
    EMBEDDING_API_KEY: str | None = None

    # Retrieval / cache behaviour.
    RETRIEVAL_CANDIDATES: int = 50
    # Threshold is embedding-provider dependent: neural models tolerate
    # 0.9+; sparse hash embeddings need ~0.5. Tune per deployment.
    SEMANTIC_CACHE_THRESHOLD: float = Field(default=0.92, ge=0.3, le=1.0)
    CACHE_TTL_SECONDS: int = 3_600
    KB_MAX_DOCS_PER_TENANT: int = 1_000
    KB_MAX_UPLOAD_BYTES: int = 8 * 1024 * 1024

    RAG_PIPELINE_PORT: int = 8000
    LOG_LEVEL: Literal["fatal", "error", "warn", "info", "debug", "trace"] = "info"

    @model_validator(mode="after")
    def enforce_production_invariants(self) -> Settings:
        if self.AXIOM_ENV == "production" and len(self.AXIOM_INTER_SERVICE_SECRET) < 32:
            raise ValueError(
                "AXIOM_INTER_SERVICE_SECRET must be at least 32 characters in production"
            )
        if self.EMBEDDING_PROVIDER == "openai" and not (
            self.EMBEDDING_API_BASE and self.EMBEDDING_API_KEY
        ):
            raise ValueError(
                "EMBEDDING_API_BASE and EMBEDDING_API_KEY are required for the openai provider"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
