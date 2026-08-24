# axiom-agent-runtime

The compute engine for long-running agents: durable async jobs, sandboxed tool
execution, context assembly, and webhook fan-out. Part of the
[Axiom AI](../../README.md) platform. Node 20+ on **:5000**.

## Status — Phase 3 complete

| Epic | Capability | Where |
|------|------------|-------|
| A1 | BullMQ substrate: `agent-exec`, `tool-exec`, `webhook-delivery` (+DLQ stream), idempotency keys, tenant priority lanes, run submission/status API | `src/queues.ts`, `src/runtime.ts` |
| A2 | Step-based orchestrator (plan → tool → observe → final) with an immutable event log (Postgres/memory); killed workers resume from the last durable event; token & step budgets; approval gates | `src/agents/orchestrator.ts`, `src/agents/eventStore.ts` |
| A3 | isolated-vm sandbox: one Isolate per execution with heap + CPU caps and a JSON-only bridge. Red-team suite proves loops/heap bombs/module loads/network/host handles all fail closed | `src/sandbox/` |
| A4 | Context assembler: system + tool docs + newest-first history packed to model windows with truncation markers | `src/agents/context.ts` |
| A5 | Webhook fan-out: HMAC-SHA256 signatures, jittered exponential backoff, DLQ stream + replay, exactly-once observation via event-id dedupe | `src/webhooks/dispatcher.ts` |

Temporal is deferred post-v1 per [ADR 0003](../../docs/adr/0003-bullmq-first-temporal-deferred.md).

## Run

```bash
npm run dev      # tsx watch on :5000
npm test         # unit + red-team suites
TEST_WEBHOOKS_INTEGRATION=1 npm test   # also exercises Redis-backed fan-out
```

## API

| Route | Description |
|-------|-------------|
| `POST /v1/agents/runs` | Submit a run (`202 {runId,state}`); same `idempotencyKey` dedupes |
| `GET /v1/agents/runs/:id` | Run status (`running / awaiting_approval / completed / failed`) |
| `GET /v1/agents/runs/:id/events` | Full event-sourced step log |
| `POST /v1/webhooks/test` | Signed receiver used by the fan-out integration suite |

### Agent decision protocol

The planner model returns a JSON decision each step:

```json
{"type": "tool_call", "tool": "calculator", "arguments": {"expression": "6*7"}}
{"type": "final", "text": "42"}
```

Tool calls pause when a definition sets `requiresApproval`; resubmitting the
run with `approval.grantedBy` resumes it from the exact paused event.

## Configuration

Shared env contract plus agent-specific keys — see root
[`.env.example`](../../.env.example): `AGENT_RUNTIME_LLM_API_KEY` (gateway key
for planner calls), `AGENT_RUNTIME_PG_URI` (durable event log; in-memory when
unset), `REDIS_PRIMARY_URL` (queues).
