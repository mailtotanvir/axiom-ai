# axiom-gateway

The front door for all LLM traffic: routing, authentication, rate limiting,
metering, and streaming. Part of the [Axiom AI](../../README.md) platform.

## Status

Phase 0 scaffold: health/readiness endpoints, bootstrap model catalog, Axiom
error contract, OTel export. Phase 1 adds provider adapters (G1), SSE
streaming (G2), auth (G3), rate limits (G4), fallback router (G5), metering (G6).

## Run

```bash
npm run dev      # tsx watch on :3000
npm test         # vitest
```

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness (dependency checks land in Phase 1) |
| `GET /v1/models` | Model catalog with capability metadata |

## Configuration

Reads the shared environment contract via `@axiom-ai/core` — see the root
[`.env.example`](../../.env.example). Startup fails fast on invalid config.
