# Contributing to Axiom AI

Thank you for investing your time in contributing to Axiom AI. This project follows the [ Contributor Covenant ](CODE_OF_CONDUCT.md); by participating, you are expected to uphold it.

## Project layout

Axiom AI ships as five cooperating packages. During the build phase they live in one workspace; at release they are published as independent repositories:

| Directory | Published repo | Role |
|-----------|----------------|------|
| `packages/core-shared` | `axiom-core-shared` | Shared contracts: types, Zod config schemas, crypto signing, Protobuf definitions |
| `services/gateway` | `axiom-gateway` | LLM gateway & proxy |
| `services/rag-pipeline` | `axiom-rag-pipeline` | Knowledge ingestion & retrieval |
| `services/agent-runtime` | `axiom-agent-runtime` | Async agent compute engine |
| `services/ops-observability` | `axiom-ops-observability` | Tracing, evals, prompt registry |

## Getting started

```bash
git clone https://github.com/axiom-ai/axiom.git && cd axiom
make install     # TS deps + Python venv
make up          # boot infra + services via docker compose
make smoke       # verify every service answers /healthz
make test        # unit + integration tests across all services
```

## Development workflow

1. **Open or claim an issue** before starting significant work.
2. **Fork & branch**: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
3. **Commit messages**: follow [Conventional Commits](https://www.conventionalcommits.org/) — e.g. `feat(gateway): add SSE backpressure handling`.
4. **Sign off commits** (DCO): `git commit -s`. All commits must include a `Signed-off-by:` line certifying the [Developer Certificate of Origin](https://developercertificate.org/).
5. **PR checklist**: tests added/updated, `make lint && make test` green, docs updated if behavior changed, ADR opened for architectural decisions.

## Coding standards

- TypeScript: strict mode, ESM, no `any` without justification comment.
- Python: typed functions, `ruff check` and `mypy` clean.
- Every service must read configuration exclusively through the Zod/pydantic schema in `@axiom-ai/core` — never raw `process.env` at call sites.
- Never log secrets, API keys, or tenant payload content.

## Reporting bugs & security issues

- Bugs and feature requests: [GitHub Issues](https://github.com/axiom-ai/axiom/issues).
- **Security vulnerabilities: do NOT open public issues.** Follow [SECURITY.md](SECURITY.md).

## Community

- Questions & design discussion: GitHub Discussions (linked from the README once published).
- Roadmap: see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
