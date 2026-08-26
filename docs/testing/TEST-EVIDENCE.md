# Test Evidence Log

Reproducible evidence for Axiom AI phase exits. Every entry lists the exact
command to re-run. Dates are execution dates; commit SHAs pin the code state.

---

## Summary matrix

| Date | Suite | Command | Result | Commit |
|------|-------|---------|--------|--------|
| 2026-08-24 | Gateway unit + E2E (vitest) | `npx vitest run --root services/gateway` | **50 passed / 10 skipped** (live-gated) | `59e559b`+ |
| 2026-08-24 | core-shared (vitest) | `npm test -w @axiom-ai/core` | **18 passed** | — |
| 2026-08-24 | agent-runtime scaffold (vitest) | `npm test -w @axiom-ai/agent-runtime` | **3 passed** | — |
| 2026-08-24 | ops-observability (vitest) | `npm test -w @axiom-ai/ops-observability` | **2 passed** | — |
| 2026-08-25 | rag-pipeline (pytest) | `.venv/bin/python -m pytest -q` | **43 passed** | — |
| 2026-08-24 | Live provider contracts | `RUN_LIVE_CONTRACT_TESTS=1 npx vitest run --root services/gateway test/liveContracts.test.ts` | **10 passed** (2 environmental skips inside) | `59e559b`+ |
| 2026-08-24 | Full-stack smoke (compose) | `scripts/smoke.sh localhost` | **8/8 checks passed** | — |
| 2026-08-24 | Lint/typecheck | `npx eslint …`, `make typecheck` | **0 errors** | — |

Skipped tests are the live provider contracts, gated by
`RUN_LIVE_CONTRACT_TESTS=1` per [ADR 0006](../adr/0006-dev-test-model-providers.md).

---

## Phase 0 — Foundation & Contracts (exit 2026-08-24)

| Criterion | Evidence |
|-----------|----------|
| All repos scaffolded with governance kit, strict tooling | Apache-2.0 kit + ADRs 0001–0007 in repo (`be56606`); ruff/mypy/eslint/tsc clean |
| CI running per service | `.github/workflows/ci.yml` matrix (build/test/lint/buf/docker) + release workflow w/ SBOM |
| `@axiom-ai/core` consumed by all services | Workspace-linked `@axiom-ai/core`; types/config/errors/crypto/telemetry imported by all TS services; pydantic mirror in rag-pipeline |
| `make up && make smoke` on clean machine | Smoke 8/8: gateway/rag/agent/ops healths, model catalog, retrieve stub, ClickHouse ping, Qdrant readiness |

## Phase 1 — Gateway MVP (exit 2026-08-24)

### Exit criteria

| Criterion | Evidence |
|-----------|----------|
| Streaming proxied through ≥3 providers with automatic failover | Live SSE verified on Groq, Mistral, NVIDIA NIM (`liveContracts.test.ts`). Failover proven in `gateway.e2e.test.ts > fails over across all three providers when primaries fail`: mistral→500, gemini→500, groq serves; upstream request counts assert exactly one attempt per candidate |
| Rate limits enforced under load | `gateway.e2e.test.ts > enforces per-tenant rate limits under burst load`: free tier (2 rpm) yields status sequence 200, 200, 429 with `x-ratelimit-limit: 2` and `retry-after`; denied requests never metered |
| Usage rows reconcile ±0% on fixture runs | `gateway.e2e.test.ts > reconciles usage rows exactly against fixture-reported tokens`: recorded prompt/completion/total equal reported 12/5/17 exactly; `reconciliationDelta` tracks estimator drift only; cost matches catalog math to 1e-10 |
| p95 added latency within budget | Latency benchmark: subtracted-baseline overhead p95 < 35 ms CI allowance (production budget 15 ms; formal k6 profiles in Phase 5) |

### Live-stack verification (containerized gateway, real providers)

```text
POST /v1/chat/completions (openai/gpt-oss-120b via groq)
  call 1 → x-axiom-provider: groq   (metered: total_tokens=122, cost=$0.00008158)
POST /v1/chat/completions stream=true (mistral-large-latest)
  → text/event-stream, 10 data frames, terminated by "data: [DONE]"
  → metered row: streamed=1, total_tokens=28, usage_source=reported
```

ClickHouse (`axiom.metering_usage_events`) confirmed rows for both modes.

### Chaos / resilience

- Mid-stream upstream kill (`cut_stream`): client receives truncated frames,
  no hang/crash, partial stream metered, never cached.
- Upstream 429/5xx classification drives failover; breaker opens after
  threshold (unit-tested state machine incl. half-open probes).

## Phase 1.1 — Input caching addendum (2026-08-24, commit `59e559b`)

| Area | Evidence |
|------|----------|
| Unit | `inputCache.test.ts` (7): key stability under key reordering, tenant separation, TTL expiry (fake timers), size-budget refusal, disabled mode, dedupe collapse (5 concurrent → 1 call). `cacheMetering.test.ts` (8): OpenAI `cached_tokens` extraction, Anthropic cache read/write extraction, discount pricing math (0.5× cached / 0.1× read / 1.25× write), Anthropic `cache_control` block translation incl. auto-system flag |
| E2E | `cache.e2e.test.ts` (7): MISS→HIT without second upstream hit; byte-identical bodies; cross-tenant identical payloads never share entries; SSE replay byte-for-byte ending `[DONE]` with zero-cost metered replay row; stampede of 5 → exactly 1 upstream + 4 `DEDUPED`; tool requests excluded; TTL expiry returns to MISS |
| Live stack | Containerized gateway against real Groq/Mistral (transcript below): identical request pair returned `x-axiom-cache: MISS` then `HIT`; streaming pair identical with HIT replay ending `[DONE]`. ClickHouse rows show `cache_hit=0` (billed) and `cache_hit=1` ($0 cost) pairs |

```text
call1: x-axiom-cache: MISS
call2: x-axiom-cache: HIT

SELECT … FROM axiom.metering_usage_events WHERE tenant_id='evidence';
┌─tenant_id─┬─model───────────────┬─provider─┬─cache_hit─┬─total_tokens─┬────usd────┐
│ evidence  │ openai/gpt-oss-120b │ groq     │     0     │     255      │ 0.00018665│
│ evidence  │ openai/gpt-oss-120b │ groq     │     1     │     255      │     0     │
└───────────┴─────────────────────┴──────────┴───────────┴──────────────┴───────────┘
```

### Live provider contract runs (2026-08-24)

```text
✓ gemini   completes (quota had recovered; earlier runs skipped as environmental)
✓ groq     completes + streams        ✓ mistral completes + streams
✓ siliconflow completes (+stream skip: invalid env API key — environmental)
✓ nvidia-nim completes + streams       Tests: 10 passed (10)
```

Environmental-skip policy: invalid/expired keys and provider free-tier quota
exhaustion are reported as skips with the upstream reason, never masked as
gateway defects.

---

## Phase 3 — Agent Runtime (exit 2026-08-24)

### Exit criteria

| Criterion | Evidence |
|-----------|----------|
| Sandbox escape suite fully blocked with enforced CPU/memory caps | `sandbox.test.ts` red-team suite (10): infinite loop killed by CPU-time cap (host responsive, <5s wall); heap bomb trips the isolate memory limit; `require("fs")` denied (no `root` leak); network egress attempt fails; `process`/`global`/`require`/`fetch` all absent inside guests; prototype pollution cannot cross isolates; registry enforces manifest bounds and payload size caps fail-closed |
| Killed worker resumes an in-flight run from last event | `orchestrator.test.ts > resumes an in-flight run from the last event after a simulated kill`: pre-seeded `run.started`, fresh orchestrator instance completes remaining steps only (2 planner calls), no duplicate `run.started` |
| Webhook receiver proves exactly-once observation over at-least-once delivery | `webhooks.test.ts`: three dispatcher attempts against a recording receiver → exactly 1 stored observation (`duplicate:true` on replays); tampered payload → 401, never recorded |
| DLQ replay restores delivery | Same file: exhausted attempts dead-letter to the Redis stream; `readDeadLetters` returns the payload; replay delivery succeeds once endpoint recovers |

### Additional coverage

- Context assembler: newest-first packing, truncation markers, bounded
  worst cases vs. registered model windows (131072 / 1M).
- Orchestrator: budget exhaustion fails structured; approval gates pause
  and resume; terminal runs are idempotent; decision parser tolerates
  fenced/embedded JSON.
- **Live-stack verification** (containerized runtime + gateway + Groq):
  submitted run completed with sandboxed calculator:
  `{state:"completed", steps:2, tokensUsed:451, output:"…6 * 7 is 42."}`;
  event log seq 1..5 persisted to Postgres
  (`run.started → step.llm → step.tool → step.llm → run.completed`).

Test totals at phase exit: **23 vitest passing** in agent-runtime (+3
Redis-gated webhook integration tests via `TEST_WEBHOOKS_INTEGRATION=1`).

## Phase 2 — RAG Pipeline (exit 2026-08-25)

### Exit criteria

| Criterion | Evidence |
|-----------|----------|
| 100-page mixed-format corpus ingested and queryable E2E < 60s | `test_recall_and_perf.py > test_100_page_corpus_ingest_and_query_under_60_seconds`: 100 markdown pages (~2500 chars each) submitted, drained to `indexed`, and queried in one budgeted run |
| Cache hit serves answer without recomputation | `test_knowledge_flow.py > test_exact_cache_serves_second_identical_query`: second identical query returns `served_from_cache: true` with byte-identical chunks; semantic tier proven by trigram-overlap paraphrase lookup (`test_cache_retrieval.py`) with no embedding API call on the hit path (httpx MockTransport asserts call counts) |
| Isolation suite passes (red-team clean) | `test_tenant_isolation.py` (9): forged/mismatched HMAC signatures rejected, tenant claimed from verified credentials only, crafted filters cannot cross tenants, Qdrant/Postgres/cache scopes all structurally partitioned, quota accounting enforced (402) |
| Authenticated smoke path | `scripts/smoke.sh localhost` signs the knowledge retrieve request with the inter-service secret; no unauthenticated stub remains |
| recall@10 regression gate wired into CI | `test_recall_and_perf.py > test_golden_set_recall_at_10_gate`: deterministic 10-topic golden set over the seeded corpus; currently **1.00** vs. gate ≥ 0.9; runs on every CI build |

### Suite breakdown (43 passing)

| File | Tests | Covers |
|------|-------|--------|
| `test_chunking_parsers.py` | 12 | Markdown heading/paragraph splits, HTML→text, sentence-window overlap, lossless reassembly, source-span offsets, parser registry fallbacks |
| `test_cache_retrieval.py` | 13 | Exact + similarity cache tiers, TTL, per-document invalidation, RRF fusion ranking, citation payload shape, batch-order-stable embeddings (MockTransport) |
| `test_tenant_isolation.py` | 9 | Cross-tenant red team (R5) |
| `test_knowledge_flow.py` | 8 | Ingest→index→retrieve E2E with citations, dedupe idempotency, corrupt-PDF failure → reprocess recovery, delete removes vectors + caches, quota 402 |
| `test_recall_and_perf.py` | 4 | Golden-set recall@10 gate, fixture completeness, 100-page perf budget |

### Scope notes / deviations from plan

- Celery workers and Unstructured are **deferred**: Phase 2 uses FastAPI
  background tasks plus native markdown/HTML/text parsers and optional
  `pypdf`; the Celery topology and parser registry remain pluggable seams
  (`app/workers/celery_app.py`, `app/core/parsers.py`).
- Semantic cache similarity lives in **Qdrant** rather than Redis vector
  search — see [ADR 0008](../adr/0008-semantic-cache-in-qdrant.md). The exact
  tier is process-local; the Redis helper is the multi-worker scale-out seam.
- Embeddings default to deterministic feature hashing for self-contained
  dev/tests; OpenAI-compatible and sentence-transformers providers are wired
  behind the same interface.
- Hybrid search fuses dense candidates with BM25 via Reciprocal Rank Fusion
  at the service layer; a native Qdrant sparse index is the scale-out path.

## Phase 4 — Ops & Observability (exit 2026-08-26)

### Exit-criteria evidence

| Criterion | Evidence |
|-----------|----------|
| One trace ID reconstructs the full request journey | `services/gateway/test/experiments.test.ts > O6 cross-service trace correlation`: inbound `traceparent` extracted, `gateway.chat` server span opened, outbound request to the mock upstream captured with a valid W3C traceparent sharing the inbound trace id and a fresh child span id. Testing exposed a real defect: `initTelemetry` never registered a propagator so OTel used NoopTextMapPropagator and no headers were ever injected — fixed in `packages/core-shared/src/telemetry.ts` (W3CTraceContextPropagator) plus chat-route extract/inject |
| Eval run gates a prompt promotion in CI | `services/ops-observability/test/evalGateCli.test.ts` (4): gate CLI scores prompt-version × model against golden datasets, exits nonzero on regression; `evalApi.test.ts`, `evals.test.ts`, `evalStore.prisma.test.ts` cover dataset CRUD, run execution, metric scoring, and the Prisma store |
| A/B split demonstrably shifts traffic with clean assignment logs | `services/gateway/test/experiments.test.ts` (11 total): 2000-key weight distribution within sane bounds of declared weights, sticky determinism per key, control-plane-down degrades to no experiment, stale rules served on refresh failure, model override + template substitution proven through the full chat route including `x-axiom-experiment*` headers; ops-side stats covered by win-probability/CI95 tests |

### Suite breakdown

- vitest totals: core 22, gateway 64 (10 live-gated skips), agent-runtime 23,
  ops-observability 46 (11 Prisma-gated skips), pytest 43.
- New this phase: gateway `experiments.test.ts` (11); ops `evalApi`,
  `evals`, `evalGateCli`, `evalStore.prisma` suites.
- Lint/typecheck clean across all four TS workspaces; compose config validated.

### Scope notes / deviations from plan

- DeepEval/Ragas metrics are implemented as in-process scorers behind the
  eval-runner interface rather than subprocess runners for v1.
- Services do not yet expose `/metrics`; the Prometheus scrape targets in
  `deploy/prometheus/prometheus.yml` are forward-looking until Phase 5 adds
  metrics exporters. Dashboards otherwise query the real ClickHouse schemas.
- Grafana provisioning, dashboards, and alert packs live under
  `deploy/grafana/` and `deploy/alerts/` (commit `ed41ceb`).

## Reproducing

```bash
make install && cp .env.example .env   # add provider keys for live tests
make build && make lint && make test
make up && make smoke
RUN_LIVE_CONTRACT_TESTS=1 npx vitest run --root services/gateway test/liveContracts.test.ts
```
