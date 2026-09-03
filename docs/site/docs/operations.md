# Operations

## Load testing

k6 profiles live in `scripts/load/`:

```bash
k6 run -e BASE_URL=http://localhost:3000 -e API_KEY=ax_... scripts/load/k6-chat-1k.js   # 1,000 concurrent SSE streams
k6 run -e BASE_URL=http://localhost:8000 -e TOKEN=<jwt> scripts/load/k6-rag-ingest.js   # 100 RPS ingestion
k6 run -e BASE_URL=http://localhost:5000 -e TOKEN=<jwt> scripts/load/k6-webhook-storm.js # 500 concurrent webhooks
```

## Chaos testing

```bash
./scripts/chaos.sh all    # redis restart, clickhouse outage, provider failover
```

Verified numbers live in `docs/benchmarks/BENCHMARKS-v1.0.md`.

## Security

- STRIDE threat models: `docs/security/`
- Secret scrubbing enforced by the shared logger (`@tanvir1971/core` secrets module)
- CI: CodeQL, gitleaks, Trivy (filesystem + container images) in `.github/workflows/security.yml`

## Billing (developer mode)

Off by default. Enable with `AXIOM_BILLING_ENABLED=true` and Stripe **test**
keys; the ops plane then exposes admin-gated usage sync and invoice preview.
