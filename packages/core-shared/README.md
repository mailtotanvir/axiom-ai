# @axiom-ai/core

Shared contracts for the Axiom AI platform: canonical TypeScript types, the
environment configuration schema, HMAC payload signing, the error taxonomy,
OpenTelemetry bootstrap, and Protobuf service definitions.

**Consumed by:** `axiom-gateway`, `axiom-agent-runtime`, `axiom-ops-observability`
(the Python `axiom-rag-pipeline` consumes the proto files and mirrors the Zod
contract in pydantic).

## Install

```bash
npm install @axiom-ai/core
```

## Usage

```ts
import { loadConfig, baseConfigSchema, errors, signPayload, verifySignature } from "@axiom-ai/core";

const config = loadConfig(baseConfigSchema.merge(myServiceSchema));
```

## Protobuf

Service definitions live in [`proto/axiom/v1`](./proto/axiom/v1) and are managed
with [Buf](https://buf.build):

```bash
cd packages/core-shared
buf lint
buf breaking --against ".git#branch=main"
```

Generated code is never committed by hand; see `buf.gen.yaml`.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # vitest
npm run lint    # eslint
```

Apache-2.0 licensed. See the repository root for contribution guidelines.
