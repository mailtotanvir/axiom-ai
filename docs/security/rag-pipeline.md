# STRIDE Threat Model: RAG Pipeline (services/rag-pipeline, :8000)

Parent: [THREAT-MODEL.md](THREAT-MODEL.md)

## Assets

Document corpora per tenant, Qdrant collections, embedding cache, semantic
cache entries, ingestion job queue.

## STRIDE analysis

| Category | Threat | Vector | Mitigation | Status |
|---|---|---|---|---|
| Spoofing | Ingestion request claims another tenant's collection | Client-supplied tenant field | Tenant id derived structurally from verified JWT, never from payload | Mitigated |
| Spoofing | Rogue worker consumes jobs for a tenant | Queue access without auth | Redis requires credentials; workers run inside the internal network only | Accepted (internal) |
| Tampering | Cross-tenant document injection into a collection | Collection name manipulation | Per-tenant collection namespace enforced server-side on every Qdrant call | Mitigated |
| Tampering | Embedding/semantic-cache poisoning | Crafted payloads colliding on cache key | Cache key includes tenant id and normalized content hash | Mitigated |
| Repudiation | Tenant denies ingesting prohibited content | No ingestion audit | Ingestion events logged with document hash, tenant, and actor claims | Mitigated |
| Information disclosure | Retrieval returns another tenant's chunks | Filter omission in a code path | Structural tenant filter mandatory in hybrid retrieval; recall@10 CI gate includes isolation assertions | Mitigated |
| Information disclosure | PII enters the corpus unredacted | Document bodies with personal data | Presidio-based PII detection/redaction hook on ingestion (milestone 5.1 guardrails); violations emit OTel audit attributes | Mitigated |
| Information disclosure | Guardrail violation details leak tenant content into logs | Verbose violation logging | Violation logs carry categories and offsets only, never raw spans; scrubbed via shared secret module | Mitigated |
| DoS | 100 RPS ingestion storm exhausts workers | Bulk upload abuse | Ingestion rate limiting per tenant; chunk-level backpressure in queue | Mitigated |
| Elevation of privilege | Arbitrary file read via parser bug | Malicious document format | Parsers run on in-memory bytes, size-capped, format allowlist; no filesystem paths from requests | Mitigated |

## Open items

1. OCR/PDF rendering libraries have wide CVE surface; Trivy image scan gates
   HIGH/CRITICAL findings on every build.
