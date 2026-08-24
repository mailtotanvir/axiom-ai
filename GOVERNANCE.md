# Governance

## Roles

- **Users** — anyone using Axiom AI. Influence via issues and discussions.
- **Contributors** — anyone with a merged PR. Listed in the repo contributors graph.
- **Maintainers** — review and merge PRs, cut releases, enforce the roadmap. Two maintainers per service area are targeted before v1.0.
- **BDFL / Project Lead** — final tie-breaker on contested decisions during the formative phase (pre-1.0).

## Decision making

| Decision type | Process |
|---------------|---------|
| Bug fixes, docs, tests | Any maintainer approves |
| Feature work | Issue + PR; one maintainer approval |
| Behavioral/API changes | Issue tagged `rfc`; 7-day comment window before merge |
| Architecture | [ADR](adr/0001-record-architecture-decisions.md) required; accepted by lazy consensus among maintainers |
| New dependencies | Must be permissively licensed (MIT/Apache/BSD/ISC), actively maintained, no known critical CVEs |

Lazy consensus: an objection from any maintainer within the comment window blocks a change until consensus or a maintainer vote (simple majority) resolves it.

## Release process

1. Every repo uses Conventional Commits; releases are cut by CI (semantic versioning).
2. Patch/minor releases may ship weekly; majors only after an RFC.
3. Security fixes follow [SECURITY.md](../SECURITY.md) disclosure timelines.

## Modifying this document

Governance changes require an ADR plus a 14-day comment window.
