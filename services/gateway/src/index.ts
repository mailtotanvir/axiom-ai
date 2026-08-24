import { CORE_VERSION } from "@axiom-ai/core";

import { createGatewayConfig } from "./config.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = createGatewayConfig();
  const app = buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({
    port: config.GATEWAY_PORT,
    host: config.GATEWAY_HOST,
  });
  app.log.info(`axiom-gateway ${CORE_VERSION} listening on ${config.GATEWAY_HOST}:${config.GATEWAY_PORT}`);
}

main().catch((error: unknown) => {
  // Fail fast on invalid configuration; log and exit non-zero.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
