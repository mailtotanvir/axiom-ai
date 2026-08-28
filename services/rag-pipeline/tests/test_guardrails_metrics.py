"""Tests for RAG pipeline PII guardrails and Prometheus metrics (Milestone 5.1)."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.core.guardrails import redact_pii
from app.core.vectorstore import InMemoryVectorStore
from app.main import create_app
from tests.conftest import TEST_SECRET, ingest_body, make_settings, sign_request


def test_redact_pii_entities() -> None:
    text = (
        "Customer John Doe (email: john.doe@example.com, phone: 555-432-1098, "
        "SSN: 987-65-4321, key: sk-1234567890abcdef1234567890, ip: 192.168.1.100)."
    )
    sanitized, entities = redact_pii(text, tenant_id="test-tenant")

    assert "[REDACTED_EMAIL]" in sanitized
    assert "[REDACTED_PHONE]" in sanitized
    assert "[REDACTED_SSN]" in sanitized
    assert "[REDACTED_API_KEY]" in sanitized
    assert "[REDACTED_IP]" in sanitized

    assert "john.doe@example.com" not in sanitized
    assert "555-432-1098" not in sanitized
    assert "987-65-4321" not in sanitized
    assert "sk-1234567890abcdef1234567890" not in sanitized

    assert "EMAIL_ADDRESS" in entities
    assert "PHONE_NUMBER" in entities
    assert "US_SSN" in entities
    assert "API_KEY" in entities
    assert "IP_ADDRESS" in entities


def test_metrics_endpoint() -> None:
    app = create_app(settings=make_settings(), vectors_override=InMemoryVectorStore())
    with TestClient(app) as client:
        health_res = client.get("/healthz")
        assert health_res.status_code == 200

        res = client.get("/metrics")
        assert res.status_code == 200
        assert "text/plain" in res.headers["content-type"]
        assert "# HELP http_server_request_duration_seconds" in res.text
        assert 'job="rag-pipeline"' in res.text


def test_ingestion_sanitizes_pii_in_chunks() -> None:
    app = create_app(settings=make_settings(), vectors_override=InMemoryVectorStore())
    with TestClient(app) as client:
        tenant_id = "test-pii-tenant"
        doc_text = (
            "# Customer Confidential Record\n\n"
            "Customer details: email ceo@enterprise.org, SSN 123-45-6789.\n"
            "This policy applies to all executive accounts and records."
        )

        body = ingest_body("customer.md", doc_text)
        res = client.post(
            "/v1/knowledge/documents",
            content=body,
            headers=sign_request(TEST_SECRET, body, tenant_id),
        )
        assert res.status_code in (200, 202)
        doc_id = res.json()["document_id"]

        # Wait for background indexing
        deadline = time.time() + 5.0
        while time.time() < deadline:
            poll = client.get(
                f"/v1/knowledge/documents/{doc_id}",
                headers=sign_request(TEST_SECRET, b"", tenant_id),
            )
            if poll.status_code == 200 and poll.json()["state"] == "indexed":
                break
            time.sleep(0.05)

        # Retrieve and verify PII was redacted from indexed vector chunks
        import json
        payload_dict = {"query": "customer details executive accounts", "top_k": 3}
        query_body = json.dumps(payload_dict).encode()
        ret_res = client.post(
            "/v1/knowledge/retrieve",
            content=query_body,
            headers=sign_request(TEST_SECRET, query_body, tenant_id),
        )
        assert ret_res.status_code == 200
        chunks = ret_res.json().get("chunks", [])
        assert len(chunks) > 0
        chunk_text = chunks[0]["text"]
        assert "[REDACTED_EMAIL]" in chunk_text
        assert "[REDACTED_SSN]" in chunk_text
        assert "ceo@enterprise.org" not in chunk_text
        assert "123-45-6789" not in chunk_text
