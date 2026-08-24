# Security Policy

Axiom AI handles untrusted code execution (tool sandboxes), multi-tenant data isolation, and upstream model credentials. We treat security reports with the highest priority.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest release on `main` | Yes |
| older tags | Best effort |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@axiom.ai** with:

1. Affected service/repo and version or commit SHA
2. Step-by-step reproduction or proof-of-concept
3. Impact assessment (what an attacker gains)
4. Any suggested mitigation

You will receive an acknowledgment within **48 hours**, and a triage decision (accepted / rejected / needs-info) within **7 days**.

## Disclosure policy

We follow coordinated disclosure:

- Reports are triaged privately; a fix is developed in a private fork.
- Credit is given to reporters in the release notes unless anonymity is requested.
- Public disclosure happens after the fix ships, typically within 90 days of the initial report.

## Scope notes for researchers

The following are explicitly in scope:

- Cross-tenant data access via any public API (gateway, retrieval, agent status)
- Sandbox escapes from the tool execution environment
- Webhook signature forgery or replay attacks
- Authentication/authorization bypasses, including JWT/API-key handling

Out of scope: volumetric DoS against demo deployments, social engineering, attacks requiring access to maintainer machines.

Thank you for helping keep Axiom AI and its users safe.
