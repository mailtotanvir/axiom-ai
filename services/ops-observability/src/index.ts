import { CORE_VERSION } from "@axiom-ai/core";

import { buildApp } from "./app.js";
import { createOpsConfig } from "./config.js";

async function main(): Promise<void> {
  const config = createOpsConfig();
  const app = buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.telemetry.shutdown();
    await app.closeStores();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.OBSERVABILITY_PORT, host: config.OBSERVABILITY_HOST });
  app.log.info(`axiom-ops-observability ${CORE_VERSION} listening on ${config.OBSERVABILITY_HOST}:${config.OBSERVABILITY_PORT}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
