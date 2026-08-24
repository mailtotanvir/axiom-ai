import { createGatewayConfig } from "./config.js";
import { startGateway } from "./app.js";

const config = createGatewayConfig();

const app = await startGateway(config).catch((error: unknown) => {
  // Fail fast on invalid configuration; log and exit non-zero.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "shutting down axiom-gateway");
  void app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
