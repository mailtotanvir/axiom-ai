# 4. Qdrant as reference vector store behind a provider interface

Date: 2026-08-24
Status: Accepted

## Context

The spec allows Qdrant or Pinecone. A credible open-source platform should be self-hostable end to end, while enterprises often bring managed vector databases.

## Decision

Define a `VectorStore` interface in `@tanvir1971/core` (upsert, search with mandatory tenant filter, delete-by-document) and implement Qdrant first. Multi-tenancy uses payload filtering enforced server-side from verified JWT claims — callers can never supply tenant filters directly.

## Consequences

`docker compose` gives a fully self-hosted stack. Pinecone or other adapters can be added without touching service code.
