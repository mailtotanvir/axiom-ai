# 3. BullMQ now, Temporal deferred

Date: 2026-08-24
Status: Accepted
Supersedes: none

## Context

`axiom-agent-runtime` needs durable async jobs with retries. Temporal provides workflow durability but adds a significant self-hosting footprint (server + DB + workers), which hurts OSS adoption and local dev experience.

## Decision

Use BullMQ on Redis for v1 agent orchestration. Event-sourced run logs give resumability for long-running agents. Temporal is deferred to post-v1 backlog; no abstraction layer will be built speculatively.

## Consequences

Simple stack (`docker compose up` includes Redis only). Long-running workflows rely on our event log + idempotent step design rather than Temporal's replay engine. If Temporal is adopted later, the queue boundary (`agent-exec`, `tool-exec`) maps cleanly onto Temporal task queues.
