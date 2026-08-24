# axiom-gateway

The front door for all LLM traffic: routing, authentication, rate limiting,
metering, and streaming. Part of the [Axiom AI](../../README.md) platform.
Node 20+ / Fastify on **:3000**.

## Status — Phase 1 complete

| Epic | Capability | Where |
|------|------------|-------|
| G1 | Provider adapters: Gemini, Groq, Mistral, SiliconFlow, NVIDIA NIM (OpenAI-compatible) + key-gated OpenAI/Anthropic; capability & cost catalog | `src/providers/` |
| G2 | SSE passthrough with byte fidelity + end-to-end backpressure; usage tapped from the stream; client-disconnect aborts upstream | `src/routes/chat.ts`, `src/providers/sse.ts` |
| G3 | `ax_` API keys stored as SHA-256 hashes (in-memory dev store + Postgres store); admin issue/revoke behind the inter-service secret | `src/auth/` |
| G4 | Redis sliding-window RPM limiter with in-memory failover; TPM token budgets; `x-ratelimit-*` headers | `src/ratelimit/` |
| G5 | Failover router (`GATEWAY_ROUTING` chains) + per-provider circuit breaker (open/half-open probes) | `src/router/` |
| G6 | tiktoken estimation reconciled against provider-reported usage; batched ClickHouse sink (+console in dev); per-model cost rollups | `src/metering/` |
| G7 | Guardrail hook chain (pass-through default; Presidio/NeMo land Phase 5) | `src/guardrails/` |

## Run

```bash
npm run dev        # tsx watch on :3000
npm test           # unit + mock-upstream E2E
RUN_LIVE_CONTRACT_TESTS=1 npm test   # also hits real provider APIs
```

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /healthz` · `GET /readyz` | Liveness / readiness |
| `GET /v1/models` | Catalog of configured providers' models |
| `POST /v1/chat/completions` | Chat proxy (streaming and non-streaming) |
| `POST /v1/admin/api-keys` | Issue a tenant key (inter-service secret auth) |
| `DELETE /v1/admin/api-keys/:hash` | Revoke a key |

### Quick tour

```bash
# Issue a key (dev: inter-service secret from .env)
curl -X POST localhost:3000/v1/admin/api-keys \
  -H "authorization: Bearer $AXIOM_INTER_SERVICE_SECRET" \
  -H 'content-type: application/json' \
  -d '{"tenantId":"acme","projectId":"portal","rateLimitTier":"pro"}'

# Stream a completion through the cheapest healthy provider
curl -N localhost:3000/v1/chat/completions \
  -H "authorization: Bearer ax_..." -H 'content-type: application/json' \
  -d '{"model":"gemini-3.6-flash","stream":true,
       "messages":[{"role":"user","content":"hi"}]}'
```

Response headers include `x-axiom-provider`, `x-axiom-model`, and
`x-ratelimit-*`. Errors use the shared Axiom error contract
(`error.code`, e.g. `AXIOM_RATE_LIMITED`, `AXIOM_ALL_UPSTREAMS_FAILED`).

## Configuration

Everything comes from the shared env contract plus gateway-specific keys —
see root [`.env.example`](../../.env.example):

| Key | Purpose |
|-----|---------|
| `GATEWAY_ROUTING` | JSON failover chains: `{"defaultChain":["gemini","groq"],"overrides":{...}}` |
| `GATEWAY_TIER_LIMITS` | JSON `{free:{requestsPerMinute,tokensPerMinute},...}` |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | Per-attempt upstream timeout |
| `GATEWAY_BREAKER_FAILURE_THRESHOLD` / `_COOLDOWN_MS` | Circuit breaker tuning |

Failover behavior: candidates are tried in declared order; network errors,
timeouts, 429s, and 5xx advance to the next candidate and trip the breaker.
Once streaming has begun a response cannot be transparently failed over —
truncations are metered and traced instead.
