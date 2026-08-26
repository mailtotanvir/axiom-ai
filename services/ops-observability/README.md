# axiom-ops-observability

The control plane: LLM lifecycle tracing (ClickHouse), evaluation engine
(DeepEval/Ragas runners), and the versioned prompt registry (PostgreSQL +
Prisma). Part of the [Axiom AI](../../README.md) platform.

## Status

Phase 0 scaffold: Fastify service on :4000, OTel export, error contract, and
the initial Prisma schema for prompts/datasets/eval runs (`prisma/schema.prisma`).
Phase 4 delivers trace ingestion (O1), prompt registry APIs (O2), eval engine
(O3), A/B traffic splitting (O4), and dashboards (O5).

## Dashboards & alerting (O5)

Grafana is provisioned from `deploy/grafana/` (datasources: ClickHouse,
Prometheus, Postgres) with four dashboards under
`deploy/grafana/dashboards/`:

- `axiom-gateway.json`: LLM gateway latency percentiles (p50/p95/p99),
  token spend by tenant/model, requests by provider.
- `axiom-cache.json`: gateway input cache hit rate plus provider-native
  cached input tokens.
- `axiom-agent-runtime.json`: queue depth and sandbox rejection counts.
- `axiom-evals.json`: eval pass rates, mean score by metric, per-run summary.

Example Prometheus alert packs live in `deploy/alerts/` (high p95 latency,
error-rate spike, agent queue growth, ClickHouse ingestion stall). Both are
wired into `docker-compose.dev.yml`: Grafana on host port 3300,
Prometheus on 9090 scraping the four services at `/metrics`.

## Eval engine (O3)

Golden datasets are versioned, tenant-scoped case sets. A run renders a
published prompt version with each case's vars, calls the model through the
gateway (temperature 0), scores with the requested metrics, and persists
per-case metric rows to ClickHouse (`axiom.eval_results`) plus a run summary
to Postgres.

Metrics: `exact`, `contains`, `regex`, `json_path_equals` (deterministic,
in-process) and `llm_judge` (model-scored against a natural-language
criterion, pass at ≥ 0.7). The overall score is the conservative minimum of
per-metric means.

```bash
# Create a dataset version
curl -X POST localhost:4000/v1/evals/datasets \
  -H 'x-axiom-internal-secret: $AXIOM_INTER_SERVICE_SECRET' \
  -d '{"tenantId":"acme","name":"support-golden","cases":[...]}'

# Run an eval: latest published+promoted prompt version × model × metrics
curl -X POST localhost:4000/v1/evals/runs -H 'x-axiom-internal-secret: ...' \
  -d '{"tenantId":"acme","dataset":{"name":"support-golden"},
       "prompt":{"name":"support-agent"},"model":"openai/gpt-oss-120b",
       "metrics":[{"type":"contains"}]}'

# CI regression gate (exit 0 = pass, 1 = fail, 2 = error)
npm run eval-gate -- --tenant acme --dataset support-golden \
  --prompt support-agent --min-score 0.9
```

## Run

```bash
npm run dev      # tsx watch on :4000
npm test
```

## Configuration

Shared env contract via `@axiom-ai/core`; see root [`.env.example`](../../.env.example).
