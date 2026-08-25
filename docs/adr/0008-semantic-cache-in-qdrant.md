# 8. Semantic cache stored in Qdrant, keyed by embedding cosine similarity

Date: 2026-08-24
Status: Accepted

## Context

The knowledge pipeline needs a semantic cache (R4) so repeated and
paraphrased queries avoid re-running retrieval. The gateway already operates
an exact-match input cache (ADR 0006-era addendum), but knowledge queries
arrive in natural language where byte-identical repetition is rare.

Options considered:

1. **Redis with a linear scan** of per-tenant embeddings — O(n) per lookup,
   no persistence story for vectors, duplicates the vector infrastructure.
2. **A dedicated vector DB for the cache** — another service to run.
3. **Qdrant collection alongside the knowledge index** — reuses the store we
   already operate (ADR 0004), gets server-side tenant filtering for free,
   and keeps cache entries close to the data they reference.

## Decision

Store semantic-cache entries in a dedicated Qdrant collection
(`cache_{scope}`) using the same embeddings as retrieval. Lookup is two-tier:
an exact-match tier (normalized query hash) followed by a cosine-similarity
tier against cached query vectors above `SEMANTIC_CACHE_THRESHOLD`. Entries
are scoped by tenant via server-side payload filters derived from verified
credentials, exactly like document vectors. Deleting or reprocessing a
document invalidates cached results referencing it.

The threshold is explicitly treated as embedding-provider dependent: neural
embeddings cluster paraphrases tightly (≥0.9 works); sparse hash embeddings
dilute under phrasing extensions (~0.5 is realistic). Operators tune it per
deployment; tests pin the fixture threshold rather than assuming one number.

## Consequences

- No new infrastructure; the compose stack already runs Qdrant.
- Cache hits return stored chunk references — deletes must invalidate both
  directions (document vectors and cache entries), which the delete/reprocess
  routes do.
- Exact tier gives zero-false-positive reuse; the similarity tier's recall
  risk is bounded by the tunable threshold and documented as such.
