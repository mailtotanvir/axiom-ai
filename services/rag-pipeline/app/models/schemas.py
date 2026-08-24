"""Pydantic wire models for ingestion and retrieval (mirror of proto/axiom/v1/knowledge.proto)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChunkingOptions(BaseModel):
    strategy: Literal["fixed", "recursive", "sentence_window", "layout"] = "recursive"
    target_chunk_tokens: int = Field(default=512, ge=64, le=8192)
    overlap_tokens: int = Field(default=64, ge=0, le=1024)


class IngestRequest(BaseModel):
    tenant_id: str
    project_id: str
    filename: str
    content_type: str = "text/plain"
    content_base64: str
    metadata: dict[str, str] = Field(default_factory=dict)
    chunking: ChunkingOptions = Field(default_factory=ChunkingOptions)


class IngestStatus(BaseModel):
    document_id: str
    state: Literal["queued", "parsing", "chunking", "embedding", "indexed", "failed"]
    chunks_indexed: int = 0
    error_message: str | None = None


class RetrieveRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4096)
    top_k: int = Field(default=5, ge=1, le=100)
    score_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    use_cache: bool = True


class RetrievedChunk(BaseModel):
    chunk_id: str
    document_id: str
    score: float
    text: str
    metadata: dict[str, str] = Field(default_factory=dict)


class RetrieveResponse(BaseModel):
    chunks: list[RetrievedChunk]
    served_from_cache: bool
