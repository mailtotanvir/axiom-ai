# Axiom AI Documentation

The five-package LLM infrastructure platform: API gateway, RAG knowledge
pipeline, agent runtime, ops and observability control plane, and the shared
contract library.

## 10-minute quickstart

```bash
git clone https://github.com/mailtotanvir/axiom-ai && cd axiom-ai
cp .env.example .env          # add one provider key (GROQ_API_KEY, MISTRAL_API_KEY, ...)
docker compose -f docker-compose.dev.yml up -d
./scripts/smoke.sh            # every service answers its health endpoint
```

The gateway is on <http://localhost:3000>:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $AXIOM_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hello"}]}'
```

Grafana dashboards: <http://localhost:3001>. Prometheus: <http://localhost:9090>.

## What lives here

| Package | Purpose | Port |
|---|---|---|
| `@axiom-ai/gateway` | Streaming LLM proxy: rate limits, failover, caching, metering | 3000 |
| `rag-pipeline` | Ingestion, hybrid retrieval, semantic cache, PII guardrails | 8000 |
| `@axiom-ai/agent-runtime` | Step orchestrator, sandbox, signed webhooks, DLQ | 5000 |
| `@axiom-ai/ops-observability` | Traces, prompt registry, evals, A/B, billing | 4000 |
| `@axiom-ai/core` | Contracts, errors, HMAC, telemetry, metrics, secret scrubbing | - |

Use the section tabs for concepts, tutorials, API reference, and operations.
