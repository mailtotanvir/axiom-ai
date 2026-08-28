# Benchmarks v1.0 (Milestone 5.3)

Status: profiles defined, results pending a full-stack run | Date: 2026-08-28

## Load profiles (scripts/load/)

| Profile | Target | Load | Exit thresholds |
|---|---|---|---|
| `k6-chat-1k.js` | Gateway :3000 | 1,000 concurrent SSE streaming connections for 3m + 100 RPS background chat | p95 non-stream latency < 2,000 ms; error rate < 1% |
| `k6-rag-ingest.js` | RAG Pipeline :8000 | 100 RPS document ingestion for 2m (4 KB documents) | p95 latency < 5,000 ms; error rate < 2% |
| `k6-webhook-storm.js` | Agent Runtime :5000 | 500 concurrent webhook dispatches for 2m | error rate < 1%; p95 dispatch latency < 1,500 ms |

## Chaos scenarios (scripts/chaos.sh)

| Scenario | Injected failure | Expected behavior |
|---|---|---|
| `redis` | Redis restart | Rate limiter/caches degrade open; gateway keeps serving; Redis recovers |
| `clickhouse` | ClickHouse outage | Metering buffering fails open; request path unblocked; recovery clean |
| `provider` | Upstream provider failure | Circuit breaker fails over the chain; fast well-formed error; no hang |

## Results

To be recorded after a full `docker compose -f docker-compose.dev.yml up` run
on the reference machine. Template per profile:

```
profile:            <name>
environment:        <cpu / ram / docker>
vus / rate:         <from profile>
duration:           <wall clock>
p50 / p95 / p99:    <ms>
error rate:         <%
throughput:         <req/s>
```

Numbers will be filled in only from an actual executed run; no estimated
figures are recorded here.
