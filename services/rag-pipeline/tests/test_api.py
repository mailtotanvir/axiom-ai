"""Health endpoint contract tests."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_returns_canonical_body():
    response = client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "axiom-rag-pipeline"


def test_readyz_available_in_phase_0():
    response = client.get("/readyz")
    assert response.status_code == 200


def test_ingest_stub_accepts_documents():
    import base64

    payload = {
        "tenant_id": "tenant_1",
        "project_id": "proj_1",
        "filename": "handbook.md",
        "content_base64": base64.b64encode(b"# Handbook\nWelcome.").decode(),
    }
    response = client.post("/v1/knowledge/documents", json=payload)
    assert response.status_code == 202
    assert response.json()["state"] == "queued"
    assert response.json()["document_id"]


def test_retrieve_stub_returns_empty_set():
    response = client.post(
        "/v1/knowledge/retrieve",
        json={"query": "What is the refund policy?", "top_k": 3},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["chunks"] == []
    assert body["served_from_cache"] is False


def test_retrieve_validates_query_length():
    response = client.post("/v1/knowledge/retrieve", json={"query": ""})
    assert response.status_code == 422
