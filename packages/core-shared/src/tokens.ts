/**
 * Token estimation shared across services (o200k BPE via tiktoken ranks).
 * Used for pre-flight budgeting where provider-reported usage does not
 * exist yet.
 */

import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const ENCODER = new Tiktoken(o200k_base);

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return ENCODER.encode(text).length;
}
