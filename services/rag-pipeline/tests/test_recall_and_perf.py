"""Golden-set recall@10 gate (CI regression) and the 100-page corpus
performance budget — Phase 2 exit criteria."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.core.vectorstore import InMemoryVectorStore
from tests.conftest import TEST_SECRET, ingest_body, make_settings, sign_request


def build_app(**overrides):
    from app.main import create_app

    return create_app(settings=make_settings(**overrides), vectors_override=InMemoryVectorStore())


# Deterministic golden set: each topic has unique vocabulary so the
# hash-embedding recall is stable across runs and machines.
GOLDEN_SET: list[dict[str, str]] = [
    {"query": "refund policy window for returns", "doc": "refunds.md"},
    {"query": "paid vacation allowance for staff", "doc": "vacation.md"},
    {"query": "password rotation requirements", "doc": "security.md"},
    {"query": "expense report submission deadline", "doc": "expenses.md"},
    {"query": "laptop hardware replacement cycle", "doc": "it-hardware.md"},
    {"query": "customer onboarding checklist steps", "doc": "onboarding.md"},
    {"query": "incident severity classification levels", "doc": "incidents.md"},
    {"query": "remote work equipment stipend", "doc": "remote.md"},
    {"query": "code review approval requirements", "doc": "engineering.md"},
    {"query": "travel booking approval process", "doc": "travel.md"},
]

CORPUS: dict[str, str] = {
    "refunds.md": (
        "# Refunds\n\nCustomers may request refunds within 30 days of "
        "purchase. Refund processing takes five business days."
    ),
    "vacation.md": (
        "# Vacation\n\nFull-time employees receive 25 days of paid vacation "
        "per year. Unused vacation days carry over partially."
    ),
    "security.md": (
        "# Passwords\n\nPassword rotation is required every 90 days. "
        "Passwords must contain at least twelve characters."
    ),
    "expenses.md": (
        "# Expenses\n\nExpense reports must be submitted within 14 days of "
        "incurring the cost. Late submissions need manager approval."
    ),
    "it-hardware.md": (
        "# Hardware\n\nLaptops are replaced on a three-year cycle. "
        "Replacement requests go through the IT service desk."
    ),
    "onboarding.md": (
        "# Onboarding\n\nCustomer onboarding follows a six-step checklist: "
        "contract, kickoff, data import, training, go-live, handover."
    ),
    "incidents.md": (
        "# Incidents\n\nIncident severity ranges from SEV1 (critical outage) "
        "to SEV4 (cosmetic). SEV1 pages the on-call engineer immediately."
    ),
    "remote.md": (
        "# Remote work\n\nRemote employees receive a one-time equipment "
        "stipend of 500 euros for home-office furniture."
    ),
    "engineering.md": (
        "# Code review\n\nEvery merge requires one approving code review. "
        "Changes to payment code require two approvals."
    ),
    "travel.md": (
        "# Travel\n\nTravel bookings above 1000 euros require pre-approval "
        "from the finance team before booking."
    ),
}


@pytest.fixture(scope="module")
def seeded() -> TestClient:
    app = build_app()
    with TestClient(app) as http:
        for filename, text in CORPUS.items():
            response = http.post(
                "/v1/knowledge/documents",
                content=ingest_body(filename, text, project_id="golden"),
                headers=sign_request(
                    TEST_SECRET, ingest_body(filename, text, project_id="golden"), "tenant-golden"
                ),
            )
            assert response.status_code == 202, response.text
        _wait_all(http)
        yield http


def _wait_all(http: TestClient) -> None:
    deadline = time.time() + 15
    while time.time() < deadline:
        states = [
            record.status.value
            for record in http.app.state.documents._records.values()  # noqa: SLF001
        ]
        if len(states) == len(CORPUS) and all(s == "indexed" for s in states):
            return
        time.sleep(0.05)
    raise AssertionError(f"corpus did not index in time: {states}")


def test_golden_set_recall_at_10_gate(seeded: TestClient) -> None:
    """recall@10 must stay >= 0.9; this gate runs on every CI build."""
    hits = 0
    misses: list[dict[str, str]] = []
    for case in GOLDEN_SET:
        body = json.dumps({"query": case["query"], "top_k": 10, "use_cache": False}).encode()
        response = seeded.post(
            "/v1/knowledge/retrieve",
            content=body,
            headers=sign_request(TEST_SECRET, body, "tenant-golden"),
        )
        assert response.status_code == 200, response.text
        chunks = response.json()["chunks"]
        retrieved_docs = [chunk["document_id"] for chunk in chunks]
        expected_id = _document_id_for("tenant-golden", case["doc"])
        if expected_id in retrieved_docs[:10]:
            hits += 1
        else:
            misses.append({"query": case["query"], "expected_doc": case["doc"]})

    recall = hits / len(GOLDEN_SET)
    assert recall >= 0.9, f"recall@10 regressed to {recall:.2f}; misses={misses}"


def test_golden_set_fixture_is_complete() -> None:
    assert len(GOLDEN_SET) == len(CORPUS)
    assert {case["doc"] for case in GOLDEN_SET} == set(CORPUS)


def _document_id_for(tenant: str, filename: str) -> str:
    """Mirrors the pipeline: the hash covers the DECODED document bytes."""
    from app.core.documents import content_hash, new_document_id

    digest = content_hash(tenant, "golden", CORPUS[filename].encode())
    return new_document_id(tenant, digest)


class TestCorpusPerformanceBudget:
    def test_100_page_corpus_ingest_and_query_under_60_seconds(self) -> None:
        """Phase 2 exit criterion: mixed-format corpus ingested and queryable
        end-to-end in under 60 seconds."""
        app = build_app()
        with TestClient(app) as http:
            tenant = "tenant-perf"
            page_text = "Section {n}: operational procedures and compliance notes.\n\n" + (
                "Detailed guidance paragraph with policy references. " * 30
            )
            documents = [(f"manual-{i:03d}.md", page_text.format(n=i)) for i in range(100)]

            started = time.time()
            ids: list[str] = []
            for filename, text in documents:
                response = http.post(
                    "/v1/knowledge/documents",
                    content=ingest_body(filename, text, project_id="perf"),
                    headers=sign_request(
                        TEST_SECRET, ingest_body(filename, text, project_id="perf"), tenant
                    ),
                )
                assert response.status_code == 202
                ids.append(response.json()["document_id"])

            deadline = time.time() + 60
            while time.time() < deadline:
                indexed = sum(
                    1
                    for document_id in ids
                    if http.get(
                        f"/v1/knowledge/documents/{document_id}",
                        headers=sign_request(TEST_SECRET, b"", tenant),
                    ).json()["state"]
                    == "indexed"
                )
                if indexed == len(ids):
                    break
                time.sleep(0.05)

            assert indexed == 100

            # Queryable E2E within the same budget.
            body = json.dumps(
                {"query": "operational procedures and compliance", "top_k": 5}
            ).encode()
            queried = http.post(
                "/v1/knowledge/retrieve",
                content=body,
                headers=sign_request(TEST_SECRET, body, tenant),
            )
            assert queried.status_code == 200
            total = time.time() - started
            assert total < 60, f"corpus pipeline took {total:.1f}s (budget 60s)"
