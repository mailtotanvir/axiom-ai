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
| 2026-08-24 | rag-pipeline (pytest) | `.venv/bin/python -m pytest -q` | **5 passed** | — |
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

## Phase 3 — Agent Runtime

Evidence will be appended at phase exit.

## Reproducing

```bash
make install && cp .env.example .env   # add provider keys for live tests
make build && make lint && make test
make up && make smoke
RUN_LIVE_CONTRACT_TESTS=1 npx vitest run --root services/gateway test/liveContracts.test.ts
```
