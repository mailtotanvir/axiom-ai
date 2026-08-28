# STRIDE Threat Model: Ops & Observability Control Plane (services/ops-observability, :4000/:14000)

Parent: [THREAT-MODEL.md](THREAT-MODEL.md)

## Assets

Prompt registry (semver templates, promotion state), eval golden datasets and
results, A/B experiment assignments, ClickHouse trace store, Grafana
dashboards, Prometheus rules.

## STRIDE analysis

| Category | Threat | Vector | Mitigation | Status |
|---|---|---|---|---|
| Spoofing | Unauthenticated promotion of a prompt to prod | Direct API call to :4000 | JWT-verified admin claims required for mutation endpoints | Mitigated |
| Spoofing | Fabricated spans injected into ClickHouse | OTLP endpoint spoofing | Collector binds internal network; exporters authenticate within the compose network | Accepted (internal) |
| Tampering | Template injection via prompt registry | Malicious template syntax | Template validation on write; semver immutability (published versions never edited) | Mitigated |
| Tampering | Experiment assignment manipulation to skew results | Sticky-hash preimage | Assignment hash includes tenant + experiment id; assignment table is append-only | Mitigated |
| Repudiation | Operator denies promotion decision | No audit trail | Registry mutations recorded with actor claims and timestamps | Mitigated |
| Information disclosure | Traces contain prompt bodies and completions | LLM span attributes | Span attributes carry token counts, models, and ids; bodies excluded from attributes; ClickHouse access is service-credential-only | Mitigated |
| Information disclosure | Metrics endpoint enumerates tenants | Public :4000/metrics scrape | Prometheus endpoints internal-network-only; labels use tenant ids, not PII | Mitigated |
| DoS | Eval run floods ClickHouse with result rows | Unbounded dataset | Eval datasets size-capped; batched inserts | Mitigated |
| DoS | Dashboard query storms | Heavy ad-hoc queries | ClickHouse query timeouts; Grafana query concurrency defaults | Accepted |
| Elevation of privilege | Read-only user reaches promotion endpoint | Missing RBAC split | Admin-only scope enforced server-side on mutation routes | Mitigated |

## Open items

1. Grafana SSO (OAuth proxy) required before any external exposure.
2. Consider per-tenant ClickHouse row policies for trace retention isolation.
