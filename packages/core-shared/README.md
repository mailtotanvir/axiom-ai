# @tanvir1971/core

Shared contracts for the Axiom AI platform: canonical TypeScript types, the
environment configuration schema, HMAC payload signing, the error taxonomy,
OpenTelemetry bootstrap, and Protobuf service definitions.

**Consumed by:** `axiom-gateway`, `axiom-agent-runtime`, `axiom-ops-observability`
(the Python `axiom-rag-pipeline` consumes the proto files and mirrors the Zod
contract in pydantic).

## Install

```bash
npm install @tanvir1971/core
```

## Usage

```ts
import { loadConfig, baseConfigSchema, errors, signPayload, verifySignature } from "@tanvir1971/core";

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
