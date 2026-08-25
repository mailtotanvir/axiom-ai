# axiom-rag-pipeline

The knowledge fabric: high-throughput document ingestion, parsing, chunking,
semantic caching, and secure multi-tenant retrieval. Part of the
[Axiom AI](../../README.md) platform. Python 3.11 + FastAPI.

## Status

Phase 2 delivered (46 tests passing):

- **Ingestion (R1)** — `POST /v1/knowledge/documents` accepts base64 payloads
  with optional explicit `content_type` (validated against the parser
  registry; magic-byte/filename sniffing as fallback). Markdown/HTML/text
  parse natively; PDF via optional `pypdf`. Content-hash deduplication makes
  resubmissions idempotent.
- **Chunking** — paragraph→sentence packing with sentence-level overlap and
  lossless reassembly; every chunk carries a `source_span` citation offset.
- **Indexing (R2)** — pluggable embeddings (`hash` default for
  self-contained dev/tests, OpenAI-compatible endpoint, or
  sentence-transformers) into Qdrant behind the [ADR 0004](../../docs/adr/0004-qdrant-reference-vector-store.md)
  provider interface; in-memory store for tests/dev.
- **Retrieval (R3)** — two-tier cache → dense vector search → BM25 fusion
  over candidates (Reciprocal Rank Fusion) → cited chunks with
  `document_id`, `chunk_id`, and byte offsets.
- **Semantic cache (R4, [ADR 0008](../../docs/adr/0008-semantic-cache-in-qdrant.md))** —
  process-local exact-match tier plus a cosine-similarity tier stored in
  Qdrant; per-document invalidation on delete/reprocess. Redis-backed exact
  sharing is the multi-worker scale-out path.
- **Tenant isolation (R5)** — HMAC-signed inter-service requests, structural
  scoping of Postgres rows, Qdrant filters, and cache entries from verified
  credentials; red-team suite proves cross-tenant blindness.
- **Durability (R6)** — failed parses persist status + error; original bytes
  are retained (bounded by the upload cap) and replayable via
  `POST /v1/knowledge/documents/{id}/reprocess`.

## API surface

| Route | Purpose |
|-------|---------|
| `POST /v1/knowledge/documents` | Ingest (202; queued→parsing→indexing→indexed/failed) |
| `GET /v1/knowledge/documents/{id}` | Status incl. chunks indexed + error message |
| `POST /v1/knowledge/documents/{id}/reprocess` | Replay original bytes after failure (202) |
| `DELETE /v1/knowledge/documents/{id}` | Remove vectors, invalidate caches |
| `POST /v1/knowledge/retrieve` | Query → ranked chunks + citations (+cache tiers) |
| `DELETE /v1/knowledge/cache/documents/{id}` | Invalidate cached results tied to a document |

Errors use the platform envelope: `{error: {code: AXIOM_*, message}}`
(e.g. `AXIOM_QUOTA_EXCEEDED` 402, `AXIOM_VALIDATION_FAILED` 400,
`AXIOM_TENANT_MISMATCH` 403).

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
uvicorn app.main:app --port 8000 --reload
pytest
ruff check app tests && mypy app
```

Or via the platform stack: `make up && make smoke` (compose wires Redis,
Postgres, and Qdrant automatically).

## Configuration

Mirrors the platform env contract (see root [`.env.example`](../../.env.example));
production requires a 32+ char inter-service secret, same as `@axiom-ai/core`.
Notables:

| Variable | Default | Notes |
|----------|---------|-------|
| `EMBEDDING_PROVIDER` | `hash` | `openai` requires `EMBEDDING_API_BASE` + `EMBEDDING_API_KEY` |
| `SEMANTIC_CACHE_THRESHOLD` | `0.92` | Embedding-provider dependent: neural models tolerate ≥0.9; sparse hash embeddings need ~0.5 |
| `KB_MAX_DOCS_PER_TENANT` | `1000` | Exceeding returns 402 |
| `KB_MAX_UPLOAD_BYTES` | `8 MiB` | Also bounds retained bytes for replay |
