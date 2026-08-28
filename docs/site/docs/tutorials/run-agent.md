# Tutorial: Run an Agent

Goal: execute a multi-step agent run and deliver a webhook.

1. Create a run with steps (BullMQ orchestrates them):

```bash
curl http://localhost:5000/v1/runs \
  -H "authorization: Bearer $AXIOM_JWT" \
  -H "content-type: application/json" \
  -d '{
        "steps": [
          {"id": "fetch", "type": "llm", "prompt": "summarize: {{input}}"},
          {"id": "notify", "type": "webhook", "url": "https://example.test/hook"}
        ]
      }'
```

2. Watch the run: event-sourced logs land in PostgreSQL; every step is a
   span joined by the same W3C trace id.

3. Webhook delivery is signed with `x-axiom-signature` (HMAC-SHA256, timestamp
   plus replay window). Verify it on your receiver before trusting the payload.

4. Failure paths: a failing step retries with jittered exponential backoff,
   then lands in the dead-letter queue. Replay it from the runtime API once
   the cause is fixed.

Tenant code steps execute in the `isolated-vm` sandbox with hard CPU and
memory limits (see [Sandbox Isolation](../concepts/sandbox.md)).
