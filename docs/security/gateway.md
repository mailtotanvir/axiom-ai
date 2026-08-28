# STRIDE Threat Model: Gateway (services/gateway, :3000)

Parent: [THREAT-MODEL.md](THREAT-MODEL.md)

## Assets

Provider API keys (env), ClickHouse metering records, cached prompt bodies
(Redis + provider-native caches), tenant JWT claims, failover chain config.

## STRIDE analysis

| Category | Threat | Vector | Mitigation | Status |
|---|---|---|---|---|
| Spoofing | Client forges tenant identity | Direct request with invented claims | RS256 JWT signature check before routing; no tenant field accepted from the body | Mitigated |
| Spoofing | Upstream impersonates a provider | DNS/route manipulation in dev | HTTPS-only provider endpoints; pinned base URLs per provider | Mitigated |
| Tampering | Response stream modified in flight | Malicious intermediary | TLS termination at Traefik; internal services on the compose network only | Mitigated |
| Tampering | Cache poisoning via crafted cache key | SHA-256 preimage of untrusted body | Key derived from full serialized payload, not client-supplied id | Mitigated |
| Repudiation | Tenant denies usage during billing dispute | Missing metering | Every request writes token metering to ClickHouse with `axiom.request.id` and trace id | Mitigated |
| Information disclosure | API key leaks into logs or spans | Error from provider carries auth header | `createSafeLogger` + `scrubObject`/`scrubSpanAttribute` redact sensitive headers and credential-shaped values; enforced by test suite | Mitigated |
| Information disclosure | Cross-tenant cache read | Shared exact-match cache keyed only by body | Cache keys include tenant id component | Mitigated |
| DoS | Stream flood exhausts connections | Unbounded SSE connections | Sliding-window rate limiter per tenant; connection caps at ingress | Mitigated |
| DoS | Circuit-breaker thrash amplifies provider outage | All traffic to dead provider | Failover chain with per-provider breakers and cooldown | Mitigated |
| Elevation of privilege | Guardrails bypass lets tenant disable PII redaction | Config tampering via API | Guardrail policy is server-side per tenant; not client-overridable per request | Mitigated |

## Open items

1. mTLS between gateway and internal services is not yet enabled (compose
   network isolation only); revisit for multi-host deploys.
2. Provider-native prompt caching stores encrypted but external copies of
   prompt bodies; documented as an accepted residual risk at platform level.
