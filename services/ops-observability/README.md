# axiom-ops-observability

The control plane: LLM lifecycle tracing (ClickHouse), evaluation engine
(DeepEval/Ragas runners), and the versioned prompt registry (PostgreSQL +
Prisma). Part of the [Axiom AI](../../README.md) platform.

## Status

Phase 0 scaffold: Fastify service on :4000, OTel export, error contract, and
the initial Prisma schema for prompts/datasets/eval runs (`prisma/schema.prisma`).
Phase 4 delivers trace ingestion (O1), prompt registry APIs (O2), eval engine
(O3), A/B traffic splitting (O4), and dashboards (O5).

## Run

```bash
npm run dev      # tsx watch on :4000
npm test
```

## Configuration

Shared env contract via `@axiom-ai/core`; see root [`.env.example`](../../.env.example).
