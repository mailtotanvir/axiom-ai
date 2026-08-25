"""Shared fixtures: deterministic app instances for knowledge API tests."""

from __future__ import annotations

import hashlib
import hmac
import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.vectorstore import InMemoryVectorStore
from app.main import create_app

TEST_SECRET = "test-inter-service-secret-for-rag-suite"


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "AXIOM_ENV": "test",
        "AXIOM_INTER_SERVICE_SECRET": TEST_SECRET,
        "QDRANT_URL": "",  # force in-memory vector store
        "EMBEDDING_PROVIDER": "hash",
        "EMBEDDING_DIM": 256,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture()
def app() -> FastAPI:
    return create_app(settings=make_settings(), vectors_override=InMemoryVectorStore())


@pytest.fixture()
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as http:
        yield http


def sign_request(
    secret: str,
    body: bytes,
    tenant_id: str,
    timestamp: int | None = None,
) -> dict[str, str]:
    ts = timestamp if timestamp is not None else int(time.time())
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = f"{ts}.{body_hash}.{tenant_id}"
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-axiom-tenant": tenant_id,
        "x-axiom-signature": f"t={ts},v1={signature}",
        "content-type": "application/json",
    }


def ingest_body(filename: str, text: str, project_id: str = "proj-1") -> bytes:
    import base64
    import json

    return json.dumps(
        {
            "filename": filename,
            "project_id": project_id,
            "content_base64": base64.b64encode(text.encode()).decode(),
            "metadata": {"source": "test"},
        }
    ).encode()
