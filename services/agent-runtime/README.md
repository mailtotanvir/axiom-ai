# axiom-agent-runtime

The compute engine for long-running agents: durable async jobs, sandboxed tool
execution, context assembly, and webhook fan-out. Part of the
[Axiom AI](../../README.md) platform.

## Status

Phase 0 scaffold: HTTP server, health endpoints, BullMQ queue topology
(`agent-exec`, `tool-exec`, `webhook-delivery`, `webhook-dlq`) with shared
retry/backoff defaults. Phase 3 adds the execution loop (A2), sandbox (A3),
context assembly (A4), and signed webhook dispatcher (A5). Temporal is
deferred post-v1 per ADR 0003.

## Run

```bash
npm run dev      # tsx watch on :5000
npm test
```

## Queue topology

| Queue | Purpose | DLQ |
|-------|---------|-----|
| `agent-exec` | Agent run steps | event-sourced run log |
| `tool-exec` | Sandboxed tool invocations | failure events |
| `webhook-delivery` | Signed outbound webhooks | `webhook-dlq` |

## Configuration

Shared env contract via `@axiom-ai/core`; see root [`.env.example`](../../.env.example).
