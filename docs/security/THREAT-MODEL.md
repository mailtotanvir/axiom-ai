# STRIDE Threat Model: Axiom AI Platform

Status: Accepted | Date: 2026-08-28 | Covers: v1.0 milestone 5.2 (X6)

This document models the platform-wide attack surface using STRIDE (Spoofing,
Tampering, Repudiation, Information disclosure, Denial of service, Elevation of
privilege). Per-service deep dives live alongside this file:

- `gateway.md` (services/gateway, :3000)
- `rag-pipeline.md` (services/rag-pipeline, :8000)
- `agent-runtime.md` (services/agent-runtime, :5000)
- `ops-observability.md` (services/ops-observability, :4000/:14000)

## Trust boundaries

```
Internet client
   |  (TB1) TLS termination + JWT validation
Traefik ingress
   |  (TB2) internal network
Gateway / RAG / Agent Runtime / Ops plane
   |  (TB3) outbound provider calls (HMAC-signed webhooks, provider API keys)
Upstream LLM providers
   |  (TB4) data-plane sinks
Redis / PostgreSQL / ClickHouse / Qdrant
```

At every boundary the assumptions are: the internal Docker network is not
client-reachable, databases require credentials from the environment, and no
service trusts an incoming tenant claim without JWT verification.

## Cross-cutting mitigations

| Threat class | Platform control |
|---|---|
| Spoofing | JWT (RS256) tenant identity on every request; HMAC-SHA256 signatures on webhooks and inter-service callbacks |
| Tampering | Signed webhook payloads with timestamp + replay window; Zod/Pydantic schema validation at every ingress; immutable append-only run/event logs |
| Repudiation | Event-sourced run logs and ClickHouse metering keyed by `axiom.request.id`; W3C trace context propagates one trace id across all services |
| Information disclosure | Secret-scrubbing (`createSafeLogger`, `scrubObject`, `scrubSpanAttribute` in `@tanvir1971/core`) applied to stdout logs and OTel span attributes; tenant isolation filters in Qdrant and SQL |
| Denial of service | Sliding-window rate limiter, circuit breaker failover chains, BullMQ queue caps, sandbox CPU/memory hard limits |
| Elevation of privilege | `isolated-vm` sandbox with no host bindings; structural (JWT-derived, not client-supplied) tenant scoping in RAG; Prometheus endpoints bind internal network only |

Secret handling: provider API keys exist only in service env vars. The
`secrets.ts` module in `@tanvir1971/core` redacts `authorization`, `x-api-key`,
`x-axiom-signature`, cookie, and credential-shaped values (bearer tokens,
`sk-`, `gsk_`, `AKIA`, `sha256=`, Stripe, PEM blocks) from anything written to
stdout or attached to a span. CI enforces this with the logger redaction test
suite plus gitleaks, Trivy, and CodeQL in `.github/workflows/security.yml`.

## Residual risks (accepted for v1.0)

1. JWT revocation is not real time; compromised tenant tokens live until expiry.
2. Provider prompt caches are external; tenants sending highly sensitive
   prompts should disable provider-native caching via the gateway config.
3. Ops-plane Grafana/Prometheus are internal-network-only; exposing them
   requires adding an SSO proxy ahead of Traefik.
