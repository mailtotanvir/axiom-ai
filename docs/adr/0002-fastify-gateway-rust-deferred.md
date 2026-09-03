# 2. Fastify for the gateway, Rust deferred

Date: 2026-08-24
Status: Accepted
Supersedes: none

## Context

The spec allows Node.js (Fastify) or Rust (Axum) for `axiom-gateway`. Rust offers superior tail latency; TypeScript shares types and tooling with `@tanvir1971/core` and the other TS services.

## Decision

Build the gateway with Fastify (TypeScript, ESM) for v1. Revisit Axum only if benchmarks after Phase 5 show the gateway cannot meet its latency budgets (p95 added overhead < 15 ms non-streaming, < 5 ms TTFB streaming) through tuning alone.

## Consequences

Fastest path to a working streaming proxy and a single contract library for all TS services. Accept a possible future rewrite of one service behind a stable HTTP/SSE boundary.
