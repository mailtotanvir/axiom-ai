/** Usage extraction from OpenAI-style SSE `data:` lines (G2/G6). */

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Finds and parses the `"usage":{...}` object in an SSE data payload without
 * full-document parsing. Returns null when absent (most chunks).
 */
export function extractUsageFromSseData(data: string): WireUsage | null {
  const marker = '"usage":';
  const start = data.indexOf(marker);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + marker.length; i < data.length; i += 1) {
    const ch = data[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    return null;
  }
  try {
    return JSON.parse(data.slice(start + marker.length, end)) as WireUsage;
  } catch {
    return null;
  }
}
