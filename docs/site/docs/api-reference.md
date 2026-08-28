# API Reference

Each service ships an OpenAPI/Swagger UI in development:

| Service | Base URL | Swagger UI |
|---|---|---|
| Gateway | http://localhost:3000 | http://localhost:3000/docs |
| RAG Pipeline | http://localhost:8000 | http://localhost:8000/docs |
| Agent Runtime | http://localhost:5000 | http://localhost:5000/api-docs |
| Ops Plane | http://localhost:4000 | http://localhost:4000/docs |

Shared contracts (Zod schemas and Protobuf definitions for every cross-service
message) live in `packages/core-shared/src` and are the source of truth for
both the TypeScript and Python services.

Key endpoint groups:

- `/v1/chat/completions` - gateway proxy (streaming + non-streaming)
- `/v1/documents/*`, `/v1/retrieval/*` - RAG ingestion and hybrid retrieval
- `/v1/runs`, `/v1/webhooks` - agent runs and webhook delivery/replay
- `/v1/traces`, `/v1/prompts`, `/v1/evals`, `/v1/experiments`, `/v1/billing` - ops plane
- `/metrics` on every service - Prometheus exposition (internal network)
