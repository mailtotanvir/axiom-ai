# STRIDE Threat Model: Agent Runtime (services/agent-runtime, :5000)

Parent: [THREAT-MODEL.md](THREAT-MODEL.md)

## Assets

Agent step definitions, `isolated-vm` sandbox processes, PostgreSQL run/event
logs, webhook endpoint registry, dead-letter queue contents.

## STRIDE analysis

| Category | Threat | Vector | Mitigation | Status |
|---|---|---|---|---|
| Spoofing | Forged webhook replay claims to be a delivery | Unauthenticated callback | HMAC-SHA256 signature (`x-axiom-signature`) with timestamp + replay window; receiver verifies before processing | Mitigated |
| Spoofing | Malicious tenant code impersonates platform APIs | Guest VM bridge abuse | Sandbox has no host bindings and no network egress; only injected pure functions | Mitigated |
| Tampering | Step code mutated between approval and execution | Queue message tampering | Step payloads validated against Zod schemas on dequeue; run logs are append-only | Mitigated |
| Tampering | Run log rewritten to hide failure | Direct DB write | Event-sourced log with append-only access from the service account | Mitigated |
| Repudiation | Tenant denies triggering a run | Missing trigger record | Run rows carry JWT subject, request id, and W3C trace id | Mitigated |
| Information disclosure | Sandbox escape reads host memory | V8 isolate weakness | Resource-capped `isolated-vm` (CPU time, memory hard limits); red-team escape suite in CI | Mitigated |
| Information disclosure | Webhook URL or signature leaks into logs | Delivery error messages | Secret-scrubbing logger redacts signature headers and bearer tokens; DLQ payloads scrubbed | Mitigated |
| DoS | Webhook delivery storm to victim endpoint | Tenant-configured sink | Jittered exponential backoff, per-endpoint caps, DLQ after bounded retries | Mitigated |
| DoS | Infinite loop in tenant code starves workers | Malicious step body | Sandbox CPU-time and wall-clock hard limits; rejections counted on `agent_runtime_sandbox_rejections_total` | Mitigated |
| Elevation of privilege | `require`/`process` reach host from guest | Sandbox builtin leakage | No host globals injected; escape suite asserts `process`, `fs`, network unavailable | Mitigated |

## Open items

1. Sandbox escape suite should add CVE-driven regression cases as
   `isolated-vm` releases land.
2. DLQ retention window should be confirmed against tenant data-deletion SLAs.
