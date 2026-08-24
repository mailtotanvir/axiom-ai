/**
 * Context assembly engine (A4, spec row 13).
 *
 * Packs system prompt + tool docs + conversation history into a message
 * list that never exceeds the model's usable input window. Priority order:
 * system prompt > tool documentation > newest turns > oldest turns.
 * Dropped turns are surfaced as an explicit truncation marker so the model
 * (and traces) can see the cut.
 */

/**
 * Heuristic estimator (~4 chars/token). Budget packing does not need
 * BPE-exact counts; this avoids pulling native/WASM tokenizers into the
 * worker runtime.
 */
function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface AssembleInput {
  /** Total context window for the target model. */
  modelWindowTokens: number;
  /** Tokens reserved for the model's response. */
  reservedOutputTokens?: number;
  systemPrompt?: string;
  /** Rendered tool documentation block (one line per tool). */
  toolDocs?: string;
  /** Conversation so far, oldest first. */
  history: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface AssembleResult {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  includedTurns: number;
  droppedTurns: number;
  truncated: boolean;
  tokensUsed: number;
}

const TRUNCATION_MARKER = (dropped: number): string =>
  `[${dropped} earlier conversation turn${dropped === 1 ? "" : "s"} omitted to fit the context window]`;

/** Hard-truncates oversized fixed blocks; never throws. */
function clipToBudget(text: string, budgetTokens: number): { text: string; clipped: boolean } {
  const total = estimateTokens(text);
  if (total <= budgetTokens) {
    return { text, clipped: false };
  }
  const safeBudget = Math.max(16, budgetTokens);
  const targetChars = Math.max(1, Math.floor(text.length * (safeBudget / total) * 0.95));
  return {
    text: `${text.slice(0, targetChars)}\n[system content truncated to fit context window]`,
    clipped: true,
  };
}

export function assembleContext(input: AssembleInput): AssembleResult {
  const reserved = input.reservedOutputTokens ?? Math.min(4_096, Math.floor(input.modelWindowTokens * 0.2));
  const usable = Math.max(256, input.modelWindowTokens - reserved);

  // Fixed blocks: always present, hard-clipped if pathological.
  let fixedTokens = 0;
  const fixedMessages: Array<{ role: "system"; content: string }> = [];

  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    const clipped = clipToBudget(input.systemPrompt, Math.floor(usable * 0.5));
    fixedMessages.push({ role: "system", content: clipped.text });
    fixedTokens += estimateTokens(clipped.text);
  }
  if (input.toolDocs !== undefined && input.toolDocs.length > 0) {
    // Tool docs yield priority to the system prompt but keep a floor.
    const budget = Math.max(64, Math.min(Math.floor(usable * 0.25), usable - fixedTokens));
    const clipped = clipToBudget(input.toolDocs, budget);
    fixedMessages.push({ role: "system", content: clipped.text });
    fixedTokens += estimateTokens(clipped.text);
  }

  // History always gets at least a small slice for the latest turn.
  const remaining = Math.max(64, usable - fixedTokens);

  // Pack newest-first so the most recent context always survives.
  const packed: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  let packedTokens = 0;
  let index = input.history.length;
  while (index > 0) {
    const turn = input.history[index - 1];
    if (turn === undefined) {
      break;
    }
    const cost = estimateTokens(turn.content) + 4; // framing overhead
    if (packedTokens + cost > remaining && packed.length > 0) {
      break;
    }
    if (packedTokens + cost > remaining) {
      // Even a single turn doesn't fit: keep its tail within the floor.
      const clipped = clipToBudget(turn.content, Math.max(64, remaining - packedTokens));
      packed.unshift({ role: turn.role, content: clipped.text });
      packedTokens += estimateTokens(clipped.text);
      index -= 1;
      break;
    }
    packed.unshift({ role: turn.role, content: turn.content });
    packedTokens += cost;
    index -= 1;
  }

  const droppedTurns = index;
  if (droppedTurns > 0) {
    packed.unshift({ role: "system", content: TRUNCATION_MARKER(droppedTurns) });
  }

  return {
    messages: [...fixedMessages, ...packed],
    includedTurns: input.history.length - droppedTurns,
    droppedTurns,
    truncated: droppedTurns > 0,
    tokensUsed:
      fixedTokens +
      packedTokens +
      (droppedTurns > 0 ? estimateTokens(TRUNCATION_MARKER(droppedTurns)) : 0),
  };
}
