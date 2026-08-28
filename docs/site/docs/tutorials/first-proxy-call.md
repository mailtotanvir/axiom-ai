# Tutorial: Your First Proxy Call

Goal: route a streaming completion through the gateway and observe it in the
ops plane.

1. Start the stack (see the [Quickstart](../quickstart.md)).
2. Send a streaming request:

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $AXIOM_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Explain proxies in one verse"}],"stream":true,"max_tokens":64}'
```

3. Watch what happened:
   - Metering row in ClickHouse: tokens, model, cost.
   - Trace in Grafana: one span per provider call with Gen-AI attributes.
   - Cache: send the identical request again; the exact-match cache answers
     without hitting the provider.

4. Try failover: set an invalid primary provider and watch the circuit
   breaker route to the next provider in the chain.
