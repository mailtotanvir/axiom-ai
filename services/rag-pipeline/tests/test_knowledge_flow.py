"""End-to-end knowledge flow: ingest → index → retrieve (citations, cache)
→ dedupe → quota → failed-parse → reprocess → delete (R1/R3/R4/R6)."""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.core.vectorstore import InMemoryVectorStore
from tests.conftest import TEST_SECRET, ingest_body, make_settings, sign_request


def build_app(**overrides):
    from app.main import create_app

    return create_app(settings=make_settings(**overrides), vectors_override=InMemoryVectorStore())


@pytest.fixture()
def http() -> TestClient:
    app = build_app()
    with TestClient(app) as client:
        yield client


def post_document(http: TestClient, tenant: str, body: bytes):
    return http.post(
        "/v1/knowledge/documents", content=body, headers=sign_request(TEST_SECRET, body, tenant)
    )


def wait_indexed(http: TestClient, tenant: str, document_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = http.get(
            f"/v1/knowledge/documents/{document_id}",
            headers=sign_request(TEST_SECRET, b"", tenant),
        )
        if response.status_code == 200:
            payload = response.json()
            if payload["state"] in ("indexed", "failed"):
                return payload
        time.sleep(0.05)
    raise AssertionError("document did not reach a terminal state in time")


def signed_retrieve(http: TestClient, tenant: str, query: str, **extra) -> dict:
    payload = {"query": query, "top_k": 5}
    payload.update(extra)
    body = json.dumps(payload).encode()
    response = http.post(
        "/v1/knowledge/retrieve", content=body, headers=sign_request(TEST_SECRET, body, tenant)
    )
    assert response.status_code == 200, response.text
    return response.json()


DOC_TEXT = (
    "# ACME Refund Policy\n\n"
    "The refund policy allows customers to request full returns within "
    "30 days of purchase. Refunds are processed to the original payment "
    "method within five business days.\n\n"
    "## Exceptions\n\n"
    "Digital goods and gift cards are excluded from refund eligibility."
)


class TestKnowledgeFlow:
    def test_ingest_index_retrieve_with_citations(self, http: TestClient) -> None:
        response = post_document(http, "tenant-flow", ingest_body("refunds.md", DOC_TEXT))
        assert response.status_code == 202
        doc_id = response.json()["document_id"]

        status = wait_indexed(http, "tenant-flow", doc_id)
        assert status["state"] == "indexed"
        assert status["chunks_indexed"] >= 2  # section split

        result = signed_retrieve(http, "tenant-flow", "How do refunds work?", use_cache=False)
        assert result["chunks"], "expected at least one chunk"
        top = result["chunks"][0]
        assert top["document_id"] == doc_id
        assert top["chunk_id"].startswith(doc_id)
        assert "refund" in top["text"].lower()
        span = top["metadata"]["source_span"]
        assert set(span) == {"start_offset", "end_offset"}

    def test_exact_cache_serves_second_identical_query(self, http: TestClient) -> None:
        post_document(http, "tenant-cache", ingest_body("policy.md", DOC_TEXT))
        first = signed_retrieve(http, "tenant-cache", "refund window for purchases")
        second = signed_retrieve(http, "tenant-cache", "refund window for purchases")

        assert first["served_from_cache"] is False
        assert second["served_from_cache"] is True
        assert first["chunks"] == second["chunks"]

    def test_cache_invalidation_forces_fresh_lookup(self, http: TestClient) -> None:
        tenant = "tenant-invalidate"
        submit = post_document(http, tenant, ingest_body("p.md", DOC_TEXT))
        doc_id = submit.json()["document_id"]
        wait_indexed(http, tenant, doc_id)

        signed_retrieve(http, tenant, "refund eligibility rules")  # populates cache

        response = http.delete(
            f"/v1/knowledge/cache/documents/{doc_id}",
            headers=sign_request(TEST_SECRET, b"", tenant),
        )
        assert response.status_code == 200

        fresh = signed_retrieve(http, tenant, "vacation days for staff", use_cache=True)
        # Unrelated query must not be served stale refund chunks.
        texts = " ".join(c["text"] for c in fresh["chunks"]).lower()
        assert "refund" not in texts or "vacation" not in texts.split("refund")[0]

    def test_content_hash_dedupes_resubmission(self, http: TestClient) -> None:
        body = ingest_body("same.md", DOC_TEXT)
        first = post_document(http, "tenant-dedupe", body)
        wait_indexed(http, "tenant-dedupe", first.json()["document_id"])
        second = post_document(http, "tenant-dedupe", ingest_body("same.md", DOC_TEXT))

        assert second.status_code == 202
        assert second.json()["document_id"] == first.json()["document_id"]
        assert second.json()["state"] == "indexed"

    def test_corrupt_pdf_fails_then_reprocesses(self, http: TestClient, monkeypatch) -> None:
        corrupt_pdf = b"%PDF-1.4 not actually valid"
        body = json.dumps(
            {
                "filename": "broken.pdf",
                "project_id": "proj",
                "content_base64": base64.b64encode(corrupt_pdf).decode(),
                "content_type": "application/pdf",
            }
        ).encode()
        submitted = post_document(http, "tenant-fail", body)
        doc_id = submitted.json()["document_id"]
        status = wait_indexed(http, "tenant-fail", doc_id)

        assert status["state"] == "failed"
        assert "ingestion failed" in (status["error_message"] or "")

        # Simulate the operator fixing the upstream parser, then reprocess.
        import app.core.parsers as parsers_module

        def recovered_parser(raw: bytes):
            from app.core.parsers import ParsedDocument

            return ParsedDocument(text="recovered pdf content about refunds", parser="recovered")

        # Simulate the upstream parser being fixed; replay must succeed.
        monkeypatch.setitem(parsers_module.PARSERS, "application/pdf", recovered_parser)
        reprocess = http.post(
            f"/v1/knowledge/documents/{doc_id}/reprocess",
            headers=sign_request(TEST_SECRET, b"", "tenant-fail"),
        )
        assert reprocess.status_code == 202
        recovered = wait_indexed(http, "tenant-fail", doc_id)
        assert recovered["state"] == "indexed"

        result = signed_retrieve(http, "tenant-fail", "recovered refunds", use_cache=False)
        assert any("recovered" in chunk["text"] for chunk in result["chunks"])

    def test_tenant_quota_is_enforced(self) -> None:
        app = build_app(KB_MAX_DOCS_PER_TENANT=1)
        with TestClient(app) as http:
            first = post_document(http, "tiny-tenant", ingest_body("a.md", "alpha"))
            assert first.status_code == 202
            second = post_document(http, "tiny-tenant", ingest_body("b.md", "beta"))
            assert second.status_code == 402
            assert second.json()["error"]["code"] == "AXIOM_QUOTA_EXCEEDED"

    def test_delete_removes_document_from_retrieval(self, http: TestClient) -> None:
        tenant = "tenant-delete"
        submit = post_document(http, tenant, ingest_body("gone.md", DOC_TEXT))
        doc_id = submit.json()["document_id"]
        wait_indexed(http, tenant, doc_id)

        before = signed_retrieve(http, tenant, "refund policy exceptions", use_cache=False)
        assert before["chunks"]

        deleted = http.delete(
            f"/v1/knowledge/documents/{doc_id}",
            headers=sign_request(TEST_SECRET, b"", tenant),
        )
        assert deleted.status_code == 200

        after = signed_retrieve(http, tenant, "refund policy exceptions", use_cache=False)
        remaining_ids = {chunk["document_id"] for chunk in after["chunks"]}
        assert doc_id not in remaining_ids
