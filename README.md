# Axiom AI

**A unified, production-grade, open-source AI platform ecosystem** — LLM gateway,
RAG knowledge fabric, agent compute engine, and observability control plane.

```text
                     ┌─────────────────────────────────────────┐
                     │       Axiom Gateway & Proxy Layer        │
                     └────────────────────┬────────────────────┘
                                          │
             ┌────────────────────────────┼────────────────────────────┐
             ▼                            ▼                            ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌──────────────────────────────┐
│     axiom-rag-pipeline        │ │     axiom-agent-runtime      │ │    axiom-ops-observability   │
├──────────────────────────────┤ ├──────────────────────────────┤ ├──────────────────────────────┤
│ - Ingestion & Chunking        │ │ - Async Job Queue (BullMQ)   │ │ - Tracing & Latency (OTel)   │
│ - Semantic Cache (Redis)      │ │ - Tool Sandbox               │ │ - Eval Engine                │
│ - Multi-Tenant Vector Store   │ │ - Webhook Fan-out System     │ │ - Prompt Registry & A/B      │
└──────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────────┘
             │                            │                            │
             └────────────────────────────┼────────────────────────────┘
                                          ▼
                     ┌─────────────────────────────────────────┐
                     │    axiom-core-shared (Core TS Library)   │
                     └─────────────────────────────────────────┘
```

## Why Axiom AI

- **One platform, four capabilities.** Route LLM traffic with metered quotas and instant failover; build multi-tenant knowledge bases; run long-lived agents with sandboxed tools; trace and evaluate everything — without stitching together five vendors.
- **Self-hostable end to end.** Every dependency (Redis, Postgres, Qdrant, ClickHouse) runs on your infrastructure.
- **Contracts first.** Protobuf + Zod schemas in `@axiom-ai/core` keep services independently deployable and independently versioned.
- **Secure by construction.** Tenant scoping derived from verified claims (never caller-supplied), HMAC-signed webhooks, resource-capped tool sandboxes.

## Repository map

During the build phase this workspace holds all packages ([ADR 0007](docs/adr/0007-workspace-overlay-build-multi-repo-release.md)); each directory becomes its own repository at release:

| Directory | Published repo | Role |
|-----------|----------------|------|
| [`packages/core-shared`](packages/core-shared) | `axiom-core-shared` | Types, config contract, crypto, protos (`@axiom-ai/core`) |
| [`services/gateway`](services/gateway) | `axiom-gateway` | LLM gateway & proxy on **:3000** |
| [`services/rag-pipeline`](services/rag-pipeline) | `axiom-rag-pipeline` | Knowledge fabric on **:8000** |
| [`services/agent-runtime`](services/agent-runtime) | `axiom-agent-runtime` | Agent compute engine on **:5000** |
| [`services/ops-observability`](services/ops-observability) | `axiom-ops-observability` | Control plane on **:4000** |

## Quickstart

Prerequisites: Node 20+, Python 3.11+, Docker with Compose v2.

```bash
git clone https://github.com/axiom-ai/axiom.git && cd axiom
make install          # TS workspaces + Python venv
cp .env.example .env  # add provider keys (Gemini/Groq/Mistral/SiliconFlow/NVIDIA NIM all work)
make up               # boot infra + all services
make smoke            # verify every health endpoint
```

You should see:

```text
ok  gateway /healthz              http://localhost:3000/healthz
ok  rag-pipeline /healthz         http://localhost:8000/healthz
...
All checks passed.
```

Then explore: Jaeger UI at http://localhost:16686, Qdrant console at
http://localhost:6333/dashboard, and Traefik routes (`Host: api.axiom.ai`)
on port 80 per the [specification](Axiom_AI_Architecture_Spec.md).

### Common commands

| Command | Purpose |
|---------|---------|
| `make build` / `make test` | Compile & test everything (vitest + pytest) |
| `make lint` / `make typecheck` | ESLint, ruff, mypy, tsc strict |
| `make logs` / `make ps` / `make down` | Compose operations |

## Status & roadmap

Phase 0 (foundation) is complete — see the live tracker in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Upcoming: gateway MVP
(provider adapters, SSE streaming, rate limits, fallback router), RAG
pipeline, agent runtime with tool sandbox, eval engine, and the v1.0 launch.

## Contributing

We welcome contributions of all sizes. Read [CONTRIBUTING.md](CONTRIBUTING.md),
sign off your commits (DCO), and check the `good first issue` label. Security
vulnerabilities follow [SECURITY.md](SECURITY.md); please do not open public
issues for them.

## License

[Apache-2.0](LICENSE)
