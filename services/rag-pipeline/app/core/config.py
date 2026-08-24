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

    GEMINI_MODEL: str = "gemini-3.6-flash"

    RAG_PIPELINE_PORT: int = 8000
    LOG_LEVEL: Literal["fatal", "error", "warn", "info", "debug", "trace"] = "info"

    @model_validator(mode="after")
    def enforce_production_invariants(self) -> Settings:
        if self.AXIOM_ENV == "production" and len(self.AXIOM_INTER_SERVICE_SECRET) < 32:
            raise ValueError(
                "AXIOM_INTER_SERVICE_SECRET must be at least 32 characters in production"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
