# 10-Minute Quickstart

Prerequisites: Docker, Node 24, Python 3.12.

## 1. Clone and configure

```bash
git clone https://github.com/mailtotanvir/axiom-ai && cd axiom-ai
cp .env.example .env
```

Add one provider key to `.env` (Groq, Mistral, Gemini, NVIDIA NIM, or
SiliconFlow). Everything else has a working dev default.

## 2. Start the stack

```bash
docker compose -f docker-compose.dev.yml up -d
```

This brings up Traefik, Redis, PostgreSQL, ClickHouse, Qdrant, Prometheus,
Grafana, and the four Axiom services.

## 3. Verify

```bash
./scripts/smoke.sh
```

All health endpoints should report ok. Grafana is on
<http://localhost:3001> with pre-provisioned dashboards per service.

## 4. Make your first call

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "authorization: Bearer $AXIOM_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

You just exercised the gateway, metering, and (if tracing is on) the
OpenTelemetry pipeline. Next: [build a RAG index](tutorials/rag-index.md).
