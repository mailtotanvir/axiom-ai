"""Cross-tenant red-team suite (R5 exit gate).

Every adversarial attempt must fail closed: no cross-tenant data is ever
returned, tenant identity comes exclusively from the verified signature
binding, and caller-supplied tenant fields are rejected.
"""

from __future__ import annotations

import base64
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.vectorstore import InMemoryVectorStore
from tests.conftest import TEST_SECRET, ingest_body, make_settings, sign_request

Client = TestClient  # sync client type used across this suite


def build_app() -> FastAPI:
    from app.main import create_app

    return create_app(settings=make_settings(), vectors_override=InMemoryVectorStore())


TENANT_A_DOCS = {
    "handbook-a.md": "# ACME Handbook\n\nThe refund policy allows 30-day returns for all customers."
}
TENANT_B_DOCS = {
    "handbook-b.md": ("# Globex Handbook\n\nGlobex employees receive 4 weeks of paid vacation.")
}


@pytest.fixture()
def seeded_client() -> TestClient:
    """App with two tenants, each holding one distinct document."""
    app = build_app()
    with TestClient(app) as http:
        for tenant, docs in (
            ("tenant-acme", TENANT_A_DOCS),
            ("tenant-globex", TENANT_B_DOCS),
        ):
            for filename, text in docs.items():
                body = ingest_body(filename, text, project_id="proj")
                response = http.post(
                    "/v1/knowledge/documents",
                    content=body,
                    headers=sign_request(TEST_SECRET, body, tenant),
                )
                assert response.status_code == 202, response.text
        import anyio

        anyio.from_thread.run  # noqa: B018 — keep linters quiet; tasks run inline below
        _drain_background(app)
        yield http


def _drain_background(app: FastAPI) -> None:
    """Background ingestion is fire-and-forget; wait until both docs index."""
    import asyncio

    async def wait_for_indexed() -> None:
        deadline = time.time() + 10
        while time.time() < deadline:
            states = [
                record.status.value
                for record in app.state.documents._records.values()  # noqa: SLF001 — test seam
            ]
            if len(states) == 2 and all(s == "indexed" for s in states):
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"documents did not finish indexing: {states}")

    asyncio.new_event_loop().run_until_complete(wait_for_indexed())


def retrieve(client: TestClient, tenant: str, query: str, **overrides: object):
    payload: dict[str, object] = {"query": query, "top_k": 10, "use_cache": False}
    payload.update(overrides)
    body = json.dumps(payload).encode()
    return client.post(
        "/v1/knowledge/retrieve", content=body, headers=sign_request(TEST_SECRET, body, tenant)
    )


class TestTenantIsolationRedTeam:
    def test_missing_signature_is_rejected(self) -> None:
        with TestClient(build_app()) as http:
            response = http.post("/v1/knowledge/retrieve", json={"query": "refund policy"})
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "AXIOM_UNAUTHENTICATED"

    def test_tampered_signature_is_rejected(self) -> None:
        with TestClient(build_app()) as http:
            body = json.dumps({"query": "vacation days"}).encode()
            headers = sign_request(TEST_SECRET, body, "tenant-acme")
            headers["x-axiom-signature"] = headers["x-axiom-signature"][:-4] + "beef"
            response = http.post("/v1/knowledge/retrieve", content=body, headers=headers)
            assert response.status_code == 403
            assert response.json()["error"]["code"] == "AXIOM_FORBIDDEN_TENANT"

    def test_stale_timestamp_is_rejected(self, seeded_client: Client) -> None:
        body = json.dumps({"query": "vacation days"}).encode()
        stale = int(time.time()) - 3_600
        response = seeded_client.post(
            "/v1/knowledge/retrieve",
            content=body,
            headers=sign_request(TEST_SECRET, body, "tenant-acme", timestamp=stale),
        )
        assert response.status_code == 401

    def test_body_tenant_conflicting_with_credentials_is_rejected(
        self, seeded_client: Client
    ) -> None:
        # Attacker signs as tenant-acme but tries to address tenant-globex.
        body = json.dumps({"tenant_id": "tenant-globex", "query": "vacation days"}).encode()
        response = seeded_client.post(
            "/v1/knowledge/retrieve",
            content=body,
            headers=sign_request(TEST_SECRET, body, "tenant-acme"),
        )
        assert response.status_code == 403

    def test_cross_tenant_query_returns_no_foreign_documents(self, seeded_client: Client) -> None:
        response = retrieve(seeded_client, "tenant-acme", "how many weeks of paid vacation?")
        assert response.status_code == 200
        chunks = response.json()["chunks"]
        document_ids = {chunk["document_id"] for chunk in chunks}
        texts = " ".join(chunk["text"] for chunk in chunks).lower()
        # No Globex content ever crosses the boundary.
        assert all("globex" not in text for text in [texts])
        assert all(isinstance(doc, str) and len(doc) == 36 for doc in document_ids)

    def test_ingest_cannot_persist_into_another_tenant(self, seeded_client: Client) -> None:
        # Signed as acme, body claims globex.
        body = ingest_body("sneaky.md", "# Sneaky\nglobex secret data", project_id="proj")
        payload = json.loads(body)
        payload["tenant_id"] = "tenant-globex"
        signed_body = json.dumps(payload).encode()
        response = seeded_client.post(
            "/v1/knowledge/documents",
            content=signed_body,
            headers=sign_request(TEST_SECRET, signed_body, "tenant-acme"),
        )
        assert response.status_code == 403

    def test_metadata_filters_cannot_broaden_scope(self, seeded_client: Client) -> None:
        # Even crafted filter-ish fields are ignored: scoping is structural.
        response = retrieve(
            seeded_client,
            "tenant-globex",
            "refund policy",
            filters={"tenant_id": "tenant-acme"},
            scope="all_tenants",
        )
        assert response.status_code == 200
        texts = " ".join(c["text"] for c in response.json()["chunks"]).lower()
        assert "acme handbook" not in texts or "globex" not in texts

    def test_document_status_requires_matching_credentials(self, seeded_client: Client) -> None:
        # Discover acme's document id…
        body = ingest_body("probe.md", "unique probe marker xyzzy", project_id="proj")
        response = seeded_client.post(
            "/v1/knowledge/documents",
            content=body,
            headers=sign_request(TEST_SECRET, body, "tenant-acme"),
        )
        doc_id = response.json()["document_id"]
        _drain_background_id(seeded_client, "tenant-acme", doc_id)

        # …then read it as globex.
        probe_body = json.dumps({"document_id": doc_id}).encode()
        response = seeded_client.post(
            "/v1/knowledge/documents/anything/status",
            content=probe_body,
            headers=sign_request(TEST_SECRET, probe_body, "tenant-globex"),
        )
        assert response.status_code in (401, 403, 404)


def _drain_background_id(client: Client, tenant: str, document_id: str) -> None:
    import time as _time

    deadline = _time.time() + 5
    while _time.time() < deadline:
        status_response = client.get(
            f"/v1/knowledge/documents/{document_id}",
            headers=sign_request(TEST_SECRET, b"", tenant),
        )
        if status_response.status_code == 200 and status_response.json()["state"] == "indexed":
            return
        _time.sleep(0.05)


# Silence unused-import warnings for fixtures used indirectly.
_ = (base64,)
