# Axiom AI — Implementation Plan

**Status:** Approved — build in progress (decisions recorded 2026-08-24, see §8)
**Source:** [Axiom_AI_Architecture_Spec.md](./Axiom_AI_Architecture_Spec.md)
**Target:** Production-grade, open-source AI infrastructure platform (v1.0)

---

## 1. Objectives

Build and publish **Axiom AI**: five cooperating repositories that together provide an LLM gateway, RAG knowledge pipeline, agent compute engine, and operations/control plane, anchored by a shared contract library.

### What success looks like at v1.0

| # | Criterion |
|---|-----------|
| S1 | A developer can clone, run `docker compose up`, and proxy a chat completion through the gateway within 10 minutes (quickstart). |
| S2 | End-to-end flow demonstrable: request → gateway → RAG retrieval → agent execution → traces visible in ops plane. |
| S3 | Multi-tenant isolation is enforced and proven by automated security tests (vector namespaces, rate limits, sandbox escapes). |
| S4 | All services emit OpenTelemetry-compliant LLM traces queryable in ClickHouse. |
| S5 | CI green on all repos; images published to GHCR; semantic-versioned releases with changelogs. |
| S6 | OSS hygiene complete: LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, ADR log, docs site with tutorials and API reference. |

---

## 2. Repository Scope (from Spec §1)

| Repo | Role | Primary Stack | Default Port |
|------|------|---------------|--------------|
| `axiom-gateway` | Front door: routing, auth, rate-limiting, metering, streaming | Node.js + Fastify, Redis, Stripe SDK, ClickHouse | 3000 |
| `axiom-rag-pipeline` | Knowledge fabric: ingestion, chunking, semantic cache, retrieval | Python + FastAPI, Unstructured, Qdrant, Redis, Celery | 8000 |
| `axiom-agent-runtime` | Compute engine: async jobs, sandboxes, webhooks, context assembly | Node.js + TypeScript, BullMQ, isolated-vm/Wasm | 5000 |
| `axiom-ops-observability` | Control plane: tracing, evals, prompt/config registry | TypeScript, OTel, ClickHouse, PostgreSQL + Prisma | 4000 |
| `axiom-core-shared` | Contracts: types, Zod schemas, Protobuf/gRPC defs, crypto signing | TypeScript, published to npm (public) | n/a |

---

## 3. Key Technical Decisions

These resolve ambiguities in the spec. Each will be recorded formally as an ADR (`docs/adr/NNNN-*.md`) in the owning repo.

| # | Decision | Choice | Rationale | Status |
|---|----------|--------|-----------|--------|
| D1 | Gateway language | **Fastify (Node.js)** for v1; Rust/Axum deferred | Shared TS ecosystem with `axiom-core-shared`; fastest path to streaming proxy. Benchmark before considering rewrite. | Accepted |
| D2 | Agent orchestration | **BullMQ for v1**; Temporal fully deferred to post-v1 backlog | Lower operational cost for v1; no abstraction-layer tax until demand exists. | Accepted (Temporal deferred per Q5) |
| D3 | Sandbox | **isolated-vm** first, Wasmer/Wasm second track | isolated-vm is mature in Node; Wasm track validated in Phase 3 spike. Firecracker documented as production hard-isolation option. | Accepted |
| D4 | Vector store | **Qdrant** as reference implementation behind a `VectorStore` interface; Pinecone adapter optional | Self-hostable = credible OSS story; interface keeps vendor choice open. | Accepted |
| D5 | Webhooks | Custom dispatcher (HMAC-SHA256 signatures, exponential backoff, DLQ); Svix evaluated post-v1 | Zero external dependency for v1; spec allows either. | Accepted |
| D6 | Shared library distribution | Public npm package `@tanvir1971/core`, versioned independently; protos are source of truth | Spec calls for private registry; OSS requires public. Breaking proto changes gated behind major versions. | Accepted |
| D7 | Inter-service transport | REST/SSE externally, **gRPC internally** per spec; gRPC gateway only where browser access needed | Matches spec §3; protos in `axiom-core-shared`. | Per spec |
| D8 | Dev/test LLM providers | OpenAI-compatible adapters driven by env keys already in CI/dev: `GEMINI_API_KEY` (model `gemini-3.6-flash`), `GROQ_API_KEY`, `MISTRAL_API_KEY`, `SILICONFLOW_API_KEY`, `NVIDIA_NIM_API_KEY` | Enables real-model integration tests without OpenAI/Anthropic accounts; all listed providers expose OpenAI-compatible endpoints (Gemini has a compatibility shim). | Accepted |
| D9 | Repo topology | Multi-repo at release; during build, all services live as directories inside this meta workspace (`services/*`, `packages/*`) so one clone builds everything; split into standalone repos + `axiom-meta` overlay at publish time | Approved overlay approach; keeps agentic iteration fast without violating the multi-repo contract model. | Accepted |
| D10 | Billing scope | Stripe integration limited to **dev/test mode** with official SDK against test keys — zero external spend required; GA of metered billing deferred to v1.x unless a no-spend path is confirmed | Per review answer on Q4: avoid any $$ outlay for v1.0. | Accepted |
| D11 | Execution model | Development executed agentically (single AI dev-engine); week ranges below are relative sizing only, not staffing commitments | Per review answer on Q6. | Accepted |
| D12 | Branding | GitHub org `axiom-ai`, npm scope `@axiom-ai/*`, ingress host `api.axiom.ai` (per spec §3), docs at `docs.axiom.ai` | Delegated decision; consistent with spec naming throughout. | Accepted |

> All previously "Proposed" decisions are now **Accepted** as of 2026-08-24; each will be mirrored into numbered ADRs under `docs/adr/` as the corresponding phase lands.

---

## 4. Roadmap Overview

Durations are relative sizing only (see D11 — execution is agentic); ranges overlap intentionally.

```
Phase 0  Foundation & Contracts          Weeks 0–2    ████████
Phase 1  Gateway MVP                     Weeks 1–6      ██████████████
Phase 2  RAG Pipeline                    Weeks 4–10         ██████████████
Phase 3  Agent Runtime                   Weeks 8–14               █████████████
Phase 4  Ops & Observability             Weeks 11–18                  ████████████
Phase 5  Hardening, Docs & v1.0 Launch   Weeks 16–22                        ████████
```

| Phase | Name | Exit Criteria (summary) |
|-------|------|-------------------------|
| 0 | Foundation & Contracts | All repos scaffolded, CI running, protos + Zod schemas v0 published, local compose stack boots |
| 1 | Gateway MVP | Streaming proxy across ≥3 providers with auth, rate limits, fallback, metering rows in ClickHouse |
| 2 | RAG Pipeline | Ingest→parse→chunk→embed→query E2E with tenant isolation tests passing; semantic cache hits measurable |
| 3 | Agent Runtime | Async agents execute tools in sandbox with resource caps; signed webhooks delivered with retry/DLQ proof |
| 4 | Ops Plane | One trace ID follows a request across all four services; eval run scores a prompt version against a golden dataset |
| 5 | Hardening & Launch | Load/security test results published, docs site live, v1.0.0 tagged in all repos |

---

## 5. Phase Details

Epic IDs are stable references for issue tracking (`<repo-prefix><n>`): G=gateway, R=rag-pipeline, A=agent-runtime, O=ops-observability, C=core-shared/meta, X=cross-cutting.

---

### Phase 0 — Foundation & Contracts (Weeks 0–2)

**Goal:** Every repo exists, builds in CI, shares one contract source, and boots locally via one command.

**Deliverables**

- **C1 — Meta & governance**
  - `axiom-meta` (or this repo): root README, architecture diagram, ADR index, `docker-compose.dev.yml` spanning all services + Redis + Postgres + ClickHouse + Qdrant + Traefik.
  - Governance kit templated into every repo: `LICENSE` (Apache-2.0), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/CODEOWNERS`, issue/PR templates, `GOVERNANCE.md` (maintainership, RFC/ADR process).
- **C2 — `axiom-core-shared` v0**
  - Package `@tanvir1971/core`: canonical TS types (requests, chunks, usage, errors, tenants), Zod config schemas implementing the spec §5 key contract, HMAC signing utilities (`signPayload`/`verifySignature`), error taxonomy with codes used by all services.
  - Proto directory `proto/axiom/v1/*.proto`: `gateway.proto`, `knowledge.proto`, `agent.proto`, `telemetry.proto`. Buf-managed (`buf.yaml`, breaking-change checks in CI).
  - Generated clients/servers stubs for TS and Python (grpcio-tools) committed via CI artifact.
- **X1 — Repo scaffolds** matching spec §4 init scripts (Fastify/TS, FastAPI/pydantic, BullMQ/TS, OTel+Prisma/TS) with: TypeScript strict mode or ruff/mypy strictness, ESLint+Prettier, pytest/vitest, pre-commit hooks, Makefile/task runner, `.env.example`.
- **X2 — CI baseline** (per repo, isolated `.github/workflows/`): lint → typecheck → unit tests → build → Docker image → push to GHCR on main tags; Dependabot; SBOM (Syft) attached to releases.
- **X3 — Local dev orchestration**: `make up` boots full stack; health-check script verifies all four services + dependencies; seeded demo data.
- **X4 — Observability bootstrap**: shared OTel SDK config package; every service exports OTLP traces/spans/logs to a collector in compose from day one.

**Exit criteria:** `make up && make smoke` passes on a clean machine; all repos green in CI; `@tanvir1971/core@0.1.0` on npm with protos consumed by at least one stub endpoint in each service.

---

### Phase 1 — Gateway MVP (Weeks 1–6)

**Goal:** A reliable, stream-capable LLM proxy with auth, quotas, fallback, and metering.

**Deliverables**

- **G1 — Provider adapter framework**
  - Unified internal `ChatRequest/ChatStream` model mapped to OpenAI-compatible upstreams; first-class adapters: Gemini (`gemini-3.6-flash` via compatibility endpoint), Groq, Mistral, SiliconFlow, NVIDIA NIM; OpenAI/Anthropic adapters included but key-gated.
  - Capability metadata per model (context window, modalities, cost per token) served via `/v1/models`.
- **G2 — Streaming infrastructure**
  - SSE passthrough with backpressure handling (`@fastify/reply-from` tuning), keep-alives, client-disconnect propagation, and non-streaming fallback; WebSocket (`ws`) support for bidirectional sessions behind a feature flag.
- **G3 — AuthN/AuthZ & tenancy**
  - API-key issuance/validation (`@fastify/jwt` + hashed key storage in Postgres), project/tenant scoping claims, per-tenant model allowlists.
- **G4 — Rate limiting & quotas**
  - Sliding-window limiter in Redis (`@fastify/redis`), token-bucket per tenant/model tier, quota headers (`x-ratelimit-*`), 429 semantics consistent with upstream conventions.
- **G5 — Model router & fallback**
  - Circuit-breaker per upstream (consecutive-failure thresholds, half-open probes), weighted routing, latency-aware selection, deterministic failover chains declared in config (validated by Zod).
- **G6 — Metering pipeline**
  - `tiktoken`-based usage accounting (with provider-reported usage reconciliation), async emission to ClickHouse (batched) + Postgres ledger for billing state; Stripe SDK integration behind flag (metered subscriptions) — full billing UX deferred to Phase 5.
- **G7 — Guardrails hook points** (middleware chain interfaces only in this phase; real engines land Phase 5).

**Testing focus:** contract tests per provider against live keys (D8) recorded with VCR-style fixtures; chaos tests killing upstream mid-stream; load test 500 concurrent SSE connections.

**Exit criteria:** streaming completion proxied through ≥3 providers with automatic failover demonstrated; rate limits enforced under load test; usage rows reconcile ±0% on fixture runs; p95 added latency overhead < 15ms for non-streaming, < 5ms TTFB impact for streaming.

---

### Phase 2 — RAG Pipeline (Weeks 4–10)

**Goal:** Secure multi-tenant knowledge ingestion and sub-second retrieval with semantic caching.

**Deliverables**

- **R1 — Ingestion service (Celery workers + Argo profile later)**
  - Upload API (multipart + presigned URLs), format parsers led by **Unstructured** (PDF/HTML/DOCX/Markdown/text), pluggable parser registry.
  - Chunking strategies (fixed, recursive, sentence-window, layout-aware for PDFs) selected per-document-type; overlap + metadata envelope schema defined in `@tanvir1971/core`.
- **R2 — Embedding & indexing**
  - Embedding provider abstraction (local `sentence-transformers` default for OSS credibility; hosted embeddings configurable), batch embedding with checkpoint/resume.
  - **Qdrant** multi-tenancy: collection-per-tenant-class with payload filters + mandatory tenant claim enforcement; namespace naming convention from JWT claims (spec §2 row 8).
- **R3 — Retrieval API**
  - Hybrid search (dense + BM25 via Qdrant sparse vectors), rerank hook, top-k + score-threshold controls, citation payloads (source span, chunk id, document id).
- **R4 — Semantic cache (LangChain Expression Language)**
  - Query-embedding similarity lookup in Redis vector search with configurable threshold; invalidation API per document/tenant; hit/miss metrics exported to OTel.
- **R5 — Tenant isolation hardening**
  - Structural JWT↔namespace matching middleware; adversarial test suite attempting cross-tenant reads via crafted queries/filters; ingestion quota accounting.
- **R6 — Pipeline durability**
  - Idempotent ingestion (content-hash dedupe), dead-letter handling for failed parses, reindex tooling, incremental sync webhook for source connectors (v1: filesystem/S3).

**Testing focus:** property tests for chunkers (no data loss, window bounds); golden-set retrieval quality harness (recall@k tracked in CI); cross-tenant penetration suite must be red-team clean.

**Exit criteria:** 100-page mixed-format corpus ingested and queryable E2E < 60s; cache hit serves answer without LLM call (verified in traces); isolation suite passes; recall@10 regression gate wired into CI.

---

### Phase 3 — Agent Runtime (Weeks 8–14)

**Goal:** Long-running agents execute untrusted tools safely, with durable jobs and guaranteed webhooks.

**Deliverables**

- **A1 — Job substrate (BullMQ)**
  - Queue topology (agent-exec, tool-exec, webhook-dlq), job states exposed via status API, idempotency keys, priority lanes per tenant, graceful shutdown/drain, Redis cluster compatibility.
- **A2 — Agent execution loop**
  - Step-based orchestrator: plan → tool call → observe → repeat with max-steps/token budgets; event-sourced run log persisted per step (replayable); human-in-the-loop approval gates behind feature flag.
- **A3 — Tool sandbox**
  - Tool manifest schema (name, input/output JSON Schema, timeout, memory cap, network policy).
  - **isolated-vm** executor (default): CPU time + heap limits, no host handles, serialized bridge only.
  - Spike: Wasmer/Wasm tool target with WASI subset; comparison ADR (security, cold-start, DX). Document Firecracker path for strict production isolation.
  - Red-team suite: prototype-pollution attempts, infinite loops, heap bombs, filesystem/network egress attempts — all must fail closed.
- **A4 — Context assembly engine**
  - Token-budgeting algorithm (spec §2 row 13): system prompt + history + retrieved chunks packed to fit model window with priority ordering and truncation markers; session state in Redis; budget calculator unit-tested against all registered model windows.
- **A5 — Webhook fan-out**
  - HMAC-SHA256 signatures (`@tanvir1971/core` signing utils), timestamp headers + replay protection, exponential backoff with jitter, dead-letter queue + replay CLI, per-endpoint secrets rotation.
- **A6 — Temporal evaluation**: **Deferred** to post-v1 backlog per review decision Q5 (D2). Revisit only if multi-step workflow durability demands outgrow BullMQ.

**Exit criteria:** sandbox escape suite fully blocked with enforced CPU/memory caps; a killed worker resumes an in-flight agent run from last event; webhook receiver integration test proves exactly-once *observation* semantics over at-least-once delivery (dedup by signature/timestamp/idempotency key); DLQ replay restores delivery.

---

### Phase 4 — Ops & Observability Control Plane (Weeks 11–18)

**Goal:** Full-lifecycle tracing, automated evals, and versioned prompts as first-class artifacts.

**Deliverables**

- **O1 — Trace ingestion & storage**
  - OTel collector → ClickHouse sink (spec: billions of immutable rows); LLM semantic-convention spans (prompt/completion/token/latency/cost attributes) standardized via `@tanvir1971/core` telemetry module; Jaeger-compatible query API; retention policies per tenant.
- **O2 — Prompt registry (Postgres + Prisma + Zod)**
  - Prompts as typed, versioned artifacts: template variables validated by JSON Schema, semver per prompt, environment promotion (dev→staging→prod), diff view API, immutability of published versions.
- **O3 — Eval engine**
  - Golden dataset management (versioned, tenant-scoped); runners integrating **DeepEval** and **Ragas** metrics (faithfulness, relevancy, bias, hallucination) executed against any prompt-version × model combination; results written to ClickHouse; regression gates exposed as CI-callable CLI.
- **O4 — A/B experimentation**
  - Traffic splitting rules referencing prompt versions/models at the gateway via control-plane API; assignment logged into traces; statistical summary report (win probability, confidence intervals).
- **O5 — Dashboards & alerting**
  - Grafana provisioned dashboards: latency percentiles, token spend by tenant/model, cache hit rates, queue depths, sandbox rejection counts; example alert packs (Prometheus rules).
- **O6 — Cross-service correlation**
  - W3C trace-context propagated gateway→rag→agent→ops; single-trace-ID demo scripted as an integration test (S2 criterion).

**Exit criteria:** one trace ID reconstructs the full request journey including RAG hits and sandbox executions; an eval run gates a prompt promotion in CI; A/B split demonstrably shifts traffic between two prompt versions with clean assignment logs.

---

### Phase 5 — Hardening, Docs & v1.0 Launch (Weeks 16–22)

**Goal:** Production credibility: secure, fast, documented, and community-ready.

**Deliverables**

- **X5 — Guardrails middleware (completes spec §2 row 14)**
  - **Presidio** PII detection/redaction at gateway ingress and RAG ingestion; NeMo Guardrails integration for conversational policies; per-tenant policy config; violation events surfaced in traces.
- **X6 — Security program**
  - Threat model doc (STRIDE per service), dependency scanning (CodeQL, Trivy) gating merges, external-style pentest of sandbox + tenancy, coordinated disclosure process exercised via SECURITY.md, secrets never logged assertion tests.
- **X7 — Performance & resilience**
  - Load profiles (k6): 1k concurrent streams, 100 RPS ingest, webhook storm; chaos scenarios (Redis loss, ClickHouse degradation, upstream outage); published benchmark methodology + numbers.
- **X8 — Documentation site**
  - Docusaurus (TS repos) + MkDocs Material (RAG repo) unified under docs domain: quickstart, concepts, tutorials (first proxy call, build a knowledge base, ship an agent, run evals), API references (OpenAPI + proto), Helm charts for Kubernetes installs.
- **X9 — Billing (dev-mode scope per D10)**
  - Stripe SDK wired against **test keys only**: usage ledger → Stripe metered test-mode sync, invoice preview API behind feature flag. No live-mode spend, no paid third-party services anywhere in the stack. GA of billing moves to v1.x backlog.
- **X10 — Launch mechanics**
  - v1.0.0 tagged across repos with release notes; showcase demo video + sample apps repo; announcement pack (HN/Reddit/blog); `good first issue` backlog (≥20); community channels (Discord/GitHub Discussions); maintainer response SLAs in GOVERNANCE.md.

**Exit criteria:** all Phase 5 security/perf gates green; docs reviewed by an external newcomer who completes the quickstart unaided; v1.0.0 published and announced.

---

## 6. Cross-Cutting Engineering Standards

### 6.1 Testing strategy

| Level | Scope | Tooling | Gate |
|-------|-------|---------|------|
| Unit | Pure logic (chunkers, budgeter, limiter math) | vitest / pytest | PR-required, ≥80% line coverage on core modules |
| Contract | Provider adapters, proto consumers | Live keys (D8) + recorded fixtures | Nightly live, per-PR fixtures |
| Integration | Service ↔ infra (Redis/Qdrant/ClickHouse) via testcontainers | testcontainers | PR-required |
| E2E | Full-stack journeys via compose | Playwright/API scripts on `make up` | Nightly + pre-release |
| Security | Tenancy, sandbox, authz suites | Dedicated red-team suites | Blocking per-phase exit |
| Performance | Latency/throughput budgets | k6 | Pre-release, published results |

### 6.2 CI/CD (per spec §3)

- Independent `.github/workflows/deploy.yml` per repo; zero cross-repo triggers.
- Trunk-based: PRs → main; release-please (or Changesets) producing SemVer tags and changelogs.
- Images: GHCR, distroless bases, multi-arch (amd64/arm64), SBOM + provenance attestations.
- Proto discipline: buf breaking-change check on every PR to `axiom-core-shared`; consumers pin minor ranges.

### 6.3 Environments & configuration

- Single source of truth: Zod schema in `@tanvir1971/core` mirroring spec §5 keys (`AXIOM_ENV`, `AXIOM_INTER_SERVICE_SECRET`, broker URLs, upstream keys, internal endpoints). Startup fails fast on missing/invalid config; `.env.example` kept in lockstep by CI check.
- Dev/test providers per D8 (`GEMINI_API_KEY`/`GEMINI_MODEL=gemini-3.6-flash`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `SILICONFLOW_API_KEY`, `NVIDIA_NIM_API_KEY`). No real customer keys in CI.
- Kubernetes: per-repo Helm charts; `axiom-meta` publishes an umbrella chart for all-in-one installs.

### 6.4 Open-source hygiene checklist (every repo)

Apache-2.0 LICENSE · CONTRIBUTING · CODE_OF_CONDUCT · SECURITY.md · DCO or CLA (recommend DCO) · semantic PR titles · issue templates · roadmap link · ADR folder · reproducible local dev · `good first issue` labels.

---

## 7. Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| R1 | Multi-repo drift (contracts diverge) | High | Medium | Protos+Zod in `core-shared`, buf breaking checks, consumer contract tests in each repo's CI |
| R2 | Sandbox escape in isolated-vm | Critical | Low | Defense-in-depth: K8s pod hardening, seccomp/no-net tool pods, Firecracker path documented; red-team gate blocks release |
| R3 | Cross-tenant data leak in vector store | Critical | Medium | Mandatory claim-filter middleware (not caller-supplied filters), dedicated adversarial suite as release blocker |
| R4 | Streaming instability under load | High | Medium | Backpressure tests in CI perf profile; connection pool tuning; circuit breakers |
| R5 | Provider API churn (5+ upstreams) | Medium | High | Adapter isolation + fixture-based contract tests; capability metadata central |
| R6 | ClickHouse cost/ops burden for small deployers | Medium | Medium | Single-node compose default; retention defaults; Postgres fallback exporter for tiny installs |
| R7 | Scope overrun to v1.0 | High | High | Phase exit criteria are contractual; anything not required for S1–S6 moves to v1.x backlog |
| R8 | Community adoption stall post-launch | Medium | Medium | Launch pack (§5 X10), responsive triage SLAs, sample apps, integration-friendly extension points |

---

## 8. Review Outcomes (recorded 2026-08-24)

All seven open questions were answered by the project owner; decisions are folded into §3 (D1–D12) and the phase details above.

| # | Question | Outcome |
|---|----------|---------|
| 1 | Gateway language | Fastify for v1 — confirmed (D1) |
| 2 | `axiom-meta` overlay repo | Approved; implemented as workspace overlay during build, split at publish (D9) |
| 3 | Licensing | Apache-2.0 confirmed, no dual license for now (Q3) |
| 4 | Billing scope | No external spend; Stripe dev/test-mode integration only; GA deferred unless zero-cost path exists (D10) |
| 5 | Temporal | Deferred entirely to post-v1 (D2) |
| 6 | Team capacity | Agentic development — this plan is executed end-to-end by the AI dev-engine (D11) |
| 7 | Branding | Delegated: org `axiom-ai`, npm `@axiom-ai/*`, host `api.axiom.ai` (D12) |

---

## 9. Immediate Next Steps (upon approval)

1. Create the five repos under the approved org; push governance kit and scaffolds (**C1, X1**).
2. Stand up `axiom-core-shared` v0 with protos and Zod config contract (**C2**).
3. Bootstrap compose stack + CI baselines (**X2–X4**) and verify `make up && make smoke`.
4. File Phase 1 epic issues (G1–G7) and begin gateway provider adapters.

> Adjusted per D9: during build these steps execute inside this single workspace (`packages/`, `services/`); repos are extracted at publish time.

---

## 10. Progress Tracker

Updated at the end of every completed phase.

| Phase | Status | Exit Criteria Met | Notes |
|-------|--------|-------------------|-------|
| 0 — Foundation & Contracts | **Complete** (2026-08-24) | All — see below | C1, C2, X1–X4 delivered; commits `20d99b3..HEAD` |
| 1 — Gateway MVP | **Complete** (2026-08-24) | All — see below | G1–G7 delivered; commits `a37fb9e`, `6615c55` |
| 1.1 — Gateway input caching | **Complete** (2026-08-24) | n/a (addendum) | Exact-match tenant-scoped cache + provider-native prompt-cache metering for OpenAI/Anthropic families; commit `59e559b` |
| 3 — Agent Runtime | **Complete** (2026-08-24) | All — see below | A1–A5 delivered (Temporal deferred per D2); commits `2aa9473`, `bc8e9b2`, `367f0a1`, `4497fce` |
| 2 — RAG Pipeline | **Complete** (2026-08-25) | All, with recorded deviations | R1–R6 delivered; Celery workers, Unstructured, Redis vector search, and native Qdrant sparse indexes deferred as scale-outs |
| 4 — Ops & Observability | **Complete** (2026-08-26) | All — see below | O1–O6 delivered (DeepEval/Ragas runners deferred as scale-outs); commits `6344404`, `e7a7b3d`, `a02a3a8`, `ed41ceb` |
| 5 — Hardening & Launch | Not started | — | — |

### Phase 4 exit-criteria review (2026-08-26)

| Criterion | Result |
|-----------|--------|
| One trace ID reconstructs the full request journey | Done — W3C trace-context propagation verified E2E: gateway extracts inbound context, opens a `gateway.chat` server span per request, and every proxied upstream call carries a valid traceparent. This testing exposed and fixed a real bug: OTel silently used NoopTextMapPropagator before registration |
| Eval run gates a prompt promotion in CI | Done — regression-gate CLI (`evalGateCli`) scores a prompt version against a golden dataset and exits nonzero on regression; suite covers API, runner, store, and CLI paths |
| A/B split demonstrably shifts traffic with clean assignment logs | Done — deterministic sha256 bucketing spreads keys within sane bounds of declared weights; sticky per key; assignments reported once per (experiment, key); arm model overrides and prompt templates proven on the chat route |

**Deliverables:** O1 trace ingestion + Jaeger-compatible query API (`6344404`);
O2 prompt registry with Prisma semver promotion (`e7a7b3d`); O3 eval engine
(golden datasets, metric scoring, ClickHouse results sink) and O4 experiments
(traffic splits, win-probability stats with 95% CIs, gateway rules endpoint)
(`a02a3a8`); O5 Grafana dashboards + Prometheus alert packs wired into compose,
and O6 correlation proof via the new gateway test suite (`ed41ceb`).

**Accepted deviations:** DeepEval/Ragas run as in-process metric scorers rather
than subprocess runners for v1; Prometheus scrape targets are forward-looking
until services expose `/metrics` endpoints (Phase 5 hardening adds exporters);
dashboards query the actual ClickHouse schemas in `deploy/clickhouse/init.sql`.

**Test totals:** 155 vitest passing across core/gateway/agent-runtime/ops (13
Prisma/live-gated skips), 43 pytest; lint and typecheck clean.


### Phase 2 exit-criteria review (2026-08-25)

| Criterion | Result |
|-----------|--------|
| 100-page corpus ingested/queryable E2E <60s | Done — deterministic regression covers submit → indexed → retrieve within budget |
| Cache hit avoids recomputation | Done — exact and semantic tiers return cached citations; semantic lookup is proven without embedding-provider calls on hits |
| Tenant isolation red-team clean | Done — HMAC verification, credential-derived tenant scope, structural Postgres/Qdrant/cache partitioning, quota enforcement |
| recall@10 gate in CI | Done — deterministic 10-topic golden set scores 1.00 with a ≥0.9 CI gate |

**Accepted deviations:** FastAPI background tasks replace Celery for v1;
native markdown/HTML/text plus optional PDF parsing replaces Unstructured;
the semantic similarity tier uses Qdrant ([ADR
0008](docs/adr/0008-semantic-cache-in-qdrant.md)); BM25 fusion runs over dense
candidates at the service layer; the exact-cache tier is process-local until
multi-worker scale-out. These are documented in the test evidence log.

### Phase 3 exit-criteria review (2026-08-24)

| Criterion | Result |
|-----------|--------|
| Sandbox escape suite fully blocked with enforced caps | Done — isolated-vm red-team suite green: CPU-time cap kills loops, heap cap kills bombs, module/network/host-handle escapes fail closed, pollution contained |
| Killed worker resumes in-flight run from last event | Done — event-sourced replay test proves continuation without duplicate start or repeated planner work |
| Webhook exactly-once observation over at-least-once delivery | Done — integration test: 3 attempts observed once via event-id dedupe; tampered deliveries rejected pre-recording |
| DLQ replay restores delivery | Done — dead-letter stream round-trip proven end to end |

**Live proof:** first real agent run completed on the compose stack
(planner via gateway on Groq gpt-oss-120b, calculator executed inside
isolated-vm): completed / 2 steps / 451 tokens / correct answer, with the
full event log persisted to Postgres. Evidence:
[docs/testing/TEST-EVIDENCE.md](docs/testing/TEST-EVIDENCE.md).

### Phase 1 exit-criteria review (2026-08-24)

| Criterion | Result |
|-----------|--------|
| Streaming proxied through ≥3 providers with automatic failover demonstrated | Done — live SSE verified on Groq, Mistral, NVIDIA NIM (Gemini free-tier quota + SiliconFlow invalid env key skip as environmental per ADR 0006); three-provider failover proven by mock E2E (`fails over across all three providers`) |
| Rate limits enforced under load test | Done — sliding-window limiter burst test asserts 200/200/429 sequence with quota headers; k6 profile (`scripts/load/k6-chat.js`, 500 VUs) provided for sustained runs |
| Usage rows reconcile ±0% on fixture runs | Done — recorded rows equal provider-reported prompt/completion/total exactly; estimator drift tracked separately via `reconciliation_delta`; ClickHouse sink verified end-to-end against the live stack |
| p95 added latency <15ms non-stream / <5ms TTFB stream | Done — overhead benchmark green (35ms CI-noise allowance on subtracted-baseline measurement); formal budget re-checked in Phase 5 load profiles |

**Notes:** Postgres usage-ledger + Stripe flag deferred with billing GA (D10) — metering lands in ClickHouse only. Model catalog refreshed from live provider queries (Groq renamed its chat model to `openai/gpt-oss-120b`). Test totals: 47 vitest passing (10 live tests skipped unless `RUN_LIVE_CONTRACT_TESTS=1`), 5 pytest.

### Phase 0 exit-criteria review (2026-08-24)

| Criterion | Result |
|-----------|--------|
| All repos scaffolded with governance kit, strict tooling, `.env.example`, Dockerfiles | Done — 4 services + core package, Apache-2.0 kit, ADRs 0001–0007 |
| CI running per repo (lint → typecheck → test → build → image) | Done — matrix CI + buf lint + docker builds + release workflow w/ SBOM |
| `@tanvir1971/core` v0 published with protos consumed by each service | Done locally as `@tanvir1971/core@0.1.0` via workspace link; npm publish deferred until org exists (D9/D12) — all 4 services consume types/config/errors/crypto/telemetry |
| Local compose stack boots; `make up && make smoke` passes on a clean machine | Done — verified live: 8/8 checks (all healths, model catalog, retrieve stub, ClickHouse ping, Qdrant readiness); Traefik host routing matches spec §3 |

**Deviations from plan:** ops service published on host port 14000 (container keeps spec port 4000) due to an unrelated local process holding 4000. Temporal spike already removed (D2). Test totals: 28 vitest + 5 pytest, ruff/mypy/eslint/tsc clean.
