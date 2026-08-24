# Axiom AI: Multi-Repo System Architecture Specification
## Engineering Blueprint for Enterprise & Open-Source AI Infrastructure

This document defines the multi-repository architecture for **Axiom AI**, a unified, production-grade AI platform ecosystem. 

```
                       ┌─────────────────────────────────────────┐
                       │       Axiom Gateway & Proxy Layer       │
                       └────────────────────┬────────────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
┌──────────────────────────────┐ ┌──────────────────────────────┐ ┌──────────────────────────────┐
│     axiom-rag-pipeline       │ │     axiom-agent-runtime      │ │    axiom-ops-observability   │
├──────────────────────────────┤ ├──────────────────────────────┤ ├──────────────────────────────┤
│ - Ingestion & Chunking       │ │ - Async Job Queue (BullMQ)   │ │ - Tracing & Latency (OTel)   │
│ - Semantic Cache (Redis)     │ │ - Tool Sandbox (Wasmer/VM2)  │ │ - Eval Engine                │
│ - Multi-Tenant Vector Store  │ │ - Webhook Fan-out System     │ │ - Prompt Registry & A/B      │
└──────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────────┘
               │                            │                            │
               └────────────────────────────┼────────────────────────────┘
                                            ▼
                       ┌─────────────────────────────────────────┐
                       │    axiom-core-shared (Core TS Library)  │
                       └─────────────────────────────────────────┘
```

---

## 1. Multi-Repo Structural Breakdown

To balance independent scaling, isolated deployment pipelines, and maximum agility, Axiom AI is split into **four distinct repositories** sharing a common version-controlled library.

### 📁 Repo 1: `axiom-gateway` (The Front Door)
*   **Purpose:** Entrypoint for all LLM traffic. Manages routing, rate-limiting, metering, and streaming.
*   **Tech Stack:** Node.js (Fastify) or Rust (Axum), Redis, Stripe SDK, EventStoreDB.
*   **Deployment:** Edge/Regional (AWS ECS or Fly.io) with auto-scaling based on concurrent HTTP connections.

### 📁 Repo 2: `axiom-rag-pipeline` (The Knowledge Fabric)
*   **Purpose:** Handles high-throughput document ingestion, parsing, chunking, semantic caching, and secure multi-tenant retrieval.
*   **Tech Stack:** Python (FastAPI), LangChain/LlamaIndex, Redis (Semantic Cache), Qdrant/Pinecone (Vector Database), Celery/Argo Workflows.
*   **Deployment:** GPU/CPU-optimized clusters (Kubernetes Pods) with horizontal scaling mapped to data ingestion queues.

### 📁 Repo 3: `axiom-agent-runtime` (The Compute Engine)
*   **Purpose:** Orchestrates long-running async agents, manages ephemeral context assembly, executes untrusted tool code in isolated sandboxes, and triggers webhooks.
*   **Tech Stack:** Node.js (TypeScript), BullMQ / Temporal, Wasmer (WebAssembly Sandbox) or Docker-in-Docker, Express (Webhook worker).
*   **Deployment:** Stateful/Worker node pools in Kubernetes with strict memory limits and CPU throttling for sandbox pods.

### 📁 Repo 4: `axiom-ops-observability` (The Control Plane)
*   **Purpose:** Traces prompt/completion lifecycles, runs automated validation/evaluation datasets on deployments, and versions production configurations.
*   **Tech Stack:** Go or Node.js, OpenTelemetry, ClickHouse (Log/Trace storage), PostgreSQL (Metadata & Prompt Registry).
*   **Deployment:** Standard cloud instances with high-disk I/O capacity for database nodes.

### 📁 Repo 5: `axiom-core-shared` (The Dependency Anchor)
*   **Purpose:** Shared TypeScript types, cryptographic signing utilities, configuration schemas, and internal gRPC/Protobuf definitions.
*   **Tech Stack:** TypeScript, NPM/GitHub Packages workspace.
*   **Deployment:** Published internally via private registry; bundled into other services during build time.

---

## 2. Technical Stack Mapping by Capability

| Capability | Chosen Frameworks / Libraries | Infrastructure / Storage | Rationale |
| :--- | :--- | :--- | :--- |
| **1. LLM Gateway & Proxy** | `Fastify`, `Proxy-Agent`, `http-proxy` | Redis (Rate limits) | Fastify has lowest overhead for streaming reverse-proxies. |
| **2. Token Metering & Billing** | `tiktoken`, `Stripe Node SDK` | PostgreSQL + ClickHouse | ClickHouse scales to billions of immutable log rows cheaply. |
| **3. Streaming Infrastructure** | `Server-Sent Events (SSE)`, `ws` | Redis Pub/Sub | Native SSE handles backpressure better than HTTP polling. |
| **4. RAG Serving Pipeline** | `LlamaIndex`, `Unstructured` | Celery Worker | Unstructured parses complex enterprise PDFs natively. |
| **5. Semantic Cache Layer** | `LangChain Expression Language` | Redis (Vector Search) | Sub-millisecond vector lookups for cached answers. |
| **6. Async Agent Job Queue** | `BullMQ` or `Temporal.io` | Redis (for BullMQ) | Temporal handles multi-step long-lived state retries best. |
| **7. Tool Execution Sandbox** | `Wasmer` (Wasm) or `isolated-vm` | Ephemeral Firecracker MicroVMs | Complete CPU/Memory isolation preventing host takeover. |
| **8. Multi-Tenant Vector Store** | `Qdrant` or `Pinecone` | Dedicated Tenant Namespaces | Row-level payload isolation via structural JWT matching. |
| **9. Prompt & Config Versioning**| `Prisma`, `Zod` | PostgreSQL | Strict structural typing for prompts acting as code artifacts. |
| **10. Eval Pipeline Backend** | `DeepEval`, `Ragas` | ClickHouse (History) | Automated assertion metrics (bias, hallucination, relevancy). |
| **11. Observability Engine** | `OpenTelemetry LLM Specs` | ClickHouse / Jaeger | Standardizes LLM tracing without vendor lock-in. |
| **12. Webhook Fan-out** | `Svix` or custom `Axios` + `Retry` | BullMQ Dead-Letter Queues | Guarantees at-least-once delivery with crypto signatures. |
| **13. Context Assembly** | `Token-budgeting algorithms` | Redis (Session State) | Dynamic structural slicing to never exceed LLM window tokens. |
| **14. Guardrails Middleware** | `NeMo Guardrails`, `Presidio` | Local memory model caches | Microsoft Presidio catches PII accurately before API ingress. |
| **15. Model Fallback / Router**| `Langchain` / Custom circuit-breaker | Upstream Health Checks | Instant recovery when OpenAI/Anthropic experience outrages. |

---

## 3. Independent Deployment Strategy

To achieve true multi-repo decoupling, deployment must be asynchronous, utilizing modern continuous delivery patterns.

### Pipeline Infrastructure (CI/CD)
*   Each repository possesses its own isolated `.github/workflows/deploy.yml` pipeline.
*   Changes to `axiom-gateway` do not trigger builds or test suites in `axiom-rag-pipeline`.

### API & Contract Layer (gRPC & Protocol Buffers)
*   Cross-repo microservice communication occurs via **gRPC** rather than fragile REST endpoints.
*   Protobuf schemas live in `axiom-core-shared`. If Repository B updates its API, it publishes a new proto version. Repository A upgrades at its own pace.

### Containerization & Ingress
```yaml
# Conceptual Monolithic API Gateway Router configuration (e.g., Traefik or Envoy)
http:
  routers:
    gateway-route:
      rule: "Host(`api.axiom.ai`) && PathPrefix(`/v1/models`)"
      service: axiom-gateway-service
    rag-route:
      rule: "Host(`api.axiom.ai`) && PathPrefix(`/v1/knowledge`)"
      service: axiom-rag-pipeline-service
    agent-route:
      rule: "Host(`api.axiom.ai`) && PathPrefix(`/v1/agents`)"
      service: axiom-agent-runtime-service
```

---

## 4. Repository Initialization Scripts

The following code blocks provide the precise terminal execution steps to establish your multi-repo workspace structures.

### 🌐 Repo 1 Initialization: `axiom-gateway`
```bash
mkdir axiom-gateway && cd axiom-gateway
npm init -y
npm install fastify @fastify/reply-from @fastify/redis @fastify/jwt zod stripe dotenv tiktoken
npm install -D typescript @types/node tsx
npx tsc --init
mkdir -p src/{routes,middleware,services,config}
touch src/server.ts src/middleware/rateLimiter.ts src/services/stripeMeter.ts
```

### 🧠 Repo 2 Initialization: `axiom-rag-pipeline`
```bash
mkdir axiom-rag-pipeline && cd axiom-rag-pipeline
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn qdrant-client langchain-core langchain-community redis sentence-transformers pydantic
mkdir -p app/{api,core,services,workers,models}
touch app/main.py app/services/semantic_cache.py app/services/ingestion.py
```

### 🤖 Repo 3 Initialization: `axiom-agent-runtime`
```bash
mkdir axiom-agent-runtime && cd axiom-agent-runtime
npm init -y
npm install bullmq ioredis isolated-vm express axios crypto
npm install -D typescript @types/node @types/express tsx
npx tsc --init
mkdir -p src/{workers,sandbox,jobs,webhooks}
touch src/index.ts src/sandbox/executor.ts src/webhooks/dispatcher.ts
```

### 📊 Repo 4 Initialization: `axiom-ops-observability`
```bash
mkdir axiom-ops-observability && cd axiom-ops-observability
npm init -y
npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http prisma @prisma/client
npm install -D typescript @types/node tsx
npx tsc --init
mkdir -p src/{traces,evals,registry,database}
touch src/index.ts src/evals/goldenRunner.ts src/registry/promptStore.ts
```

---

## 5. Architectural Contract & Configuration Matrix

Every repository must read from a centralized schema contract to prevent deployment mismatch failures. Below is the configuration key contract required by all environments.

```ini
# Core Base Infrastructure Keys
AXIOM_ENV=production
AXIOM_INTER_SERVICE_SECRET=crypto_secure_hex_string_here

# Cross-Repo Broker Configuration
REDIS_PRIMARY_URL=redis://user:password@redis-cluster.internal:6379/0
CLICKHOUSE_NODES=ch-01.internal:8123,ch-02.internal:8123
POSTGRES_DB_URI=postgresql://db_user:password@pg-master.internal:5432/axiom_metadata

# Upstream Model Authorization 
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...

# Gateway Router Endpoint Definitions
GATEWAY_INTERNAL_URL=http://axiom-gateway.internal:3000
RAG_PIPELINE_INTERNAL_URL=http://axiom-rag-pipeline.internal:8000
AGENT_RUNTIME_INTERNAL_URL=http://axiom-agent-runtime.internal:5000
OBSERVABILITY_INTERNAL_URL=http://axiom-ops-observability.internal:4000
```
# for test purpose use below AI LLM API keys which are already in the environment

GEMINI_API_KEY - model gemini-3.6-flash
GROQ_API_KEY
 MISTRAL_API_KEY
 SILICONFLOW_API_KEY
 NVIDIA_NIM_API_KEY