import { createAgentRuntimeConfig } from "./config.js";
import { startRuntime } from "./runtime.js";

const runtime = await startRuntime(createAgentRuntimeConfig()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

const shutdown = (signal: string): void => {
  console.log({ signal }, "shutting down axiom-agent-runtime");
  void runtime.shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
