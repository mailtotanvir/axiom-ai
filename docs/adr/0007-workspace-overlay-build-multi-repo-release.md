# 7. Workspace overlay during build; multi-repo at release

Date: 2026-08-24
Status: Accepted

## Context

The spec mandates independent repositories for deployment isolation. During the agentic build phase, five separate repos would slow iteration (cross-repo contract churn) and complicate local verification.

## Decision

Develop everything in this workspace under `packages/` and `services/`, with each directory structured as a standalone repo (own package.json, CI config, Dockerfile, license headers). At release, directories are extracted into `axiom-gateway`, `axiom-rag-pipeline`, `axiom-agent-runtime`, `axiom-ops-observability`, and `axiom-core-shared` repositories; cross-cutting assets (compose stacks, ADR index, docs site) move to an `axiom-meta` repo.

## Consequences

One clone builds and smokes the whole platform today. CI workflows are written per-service so extraction is mechanical. Root npm workspaces are a build convenience only — packages never import across service boundaries except via `@tanvir1971/core`.
