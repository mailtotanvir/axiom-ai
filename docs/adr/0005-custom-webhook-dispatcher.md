# 5. Custom webhook dispatcher before Svix

Date: 2026-08-24
Status: Accepted

## Context

Agent runs and ingestion jobs emit webhooks. The spec permits Svix or a custom implementation. Svix self-hosted adds another stateful dependency; SaaS use conflicts with the zero-external-spend constraint (D10).

## Decision

Build a custom dispatcher on BullMQ: HMAC-SHA256 signatures via `@axiom-ai/core`, timestamped headers with replay protection, exponential backoff with jitter, dead-letter queue, replay CLI. Evaluate Svix post-v1 if endpoint-management UX demands grow.

## Consequences

No new infrastructure for v1. We own delivery semantics (documented as at-least-once with consumer dedup keys).
