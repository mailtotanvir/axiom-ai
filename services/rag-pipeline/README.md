# axiom-rag-pipeline

The knowledge fabric: high-throughput document ingestion, parsing, chunking,
semantic caching, and secure multi-tenant retrieval. Part of the
[Axiom AI](../../README.md) platform. Python 3.11 + FastAPI.

## Status

Phase 0 scaffold: FastAPI app on :8000 with the canonical health contract,
ingestion/retrieval route stubs matching `proto/axiom/v1/knowledge.proto`,
pydantic settings mirroring the shared env contract, Celery topology, and a
no-op semantic cache interface. Phase 2 delivers Unstructured parsing (R1),
Qdrant indexing (R2), hybrid retrieval (R3), Redis vector cache (R4), and
tenant-isolation hardening (R5).

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
uvicorn app.main:app --port 8000 --reload
pytest
ruff check app tests && mypy app
```

## Configuration

Mirrors the platform env contract (see root [`.env.example`](../../.env.example));
production requires a 32+ char inter-service secret, same as `@axiom-ai/core`.
