/**
 * In-memory store runs the shared behavior suite unconditionally.
 */

import { describe } from "vitest";

import { runRegistryBehavior } from "./promptRegistry.behavior.js";
import { InMemoryPromptRegistry } from "../src/prompts/memoryStore.js";

describe("InMemoryPromptRegistry", () => {
  runRegistryBehavior(() => new InMemoryPromptRegistry());
});
