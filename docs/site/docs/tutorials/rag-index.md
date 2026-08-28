# Tutorial: Build a RAG Index

Goal: ingest documents and run a hybrid retrieval query against them.

1. Ingest a document (tenant comes from your JWT, not the payload):

```bash
curl http://localhost:8000/v1/documents/ingest \
  -H "authorization: Bearer $AXIOM_JWT" \
  -H "content-type: application/json" \
  -d '{
        "collection": "handbook",
        "documents": [{"id": "h-1", "text": "Axiom AI ingests, chunks, embeds, and retrieves."}]
      }'
```

2. PII guardrails run on ingestion automatically; any detected personal data
   is redacted and the violation is recorded as a trace attribute.

3. Retrieve with hybrid search (dense + BM25):

```bash
curl http://localhost:8000/v1/retrieval/query \
  -H "authorization: Bearer $AXIOM_JWT" \
  -H "content-type: application/json" \
  -d '{"collection": "handbook", "query": "how does ingestion work?", "top_k": 5}'
```

4. Repeat the same query: the two-tier semantic cache (exact + similarity)
   answers without re-embedding.
