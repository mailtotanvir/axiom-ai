/**
 * Dependency-free line diff for the version comparison API (O2).
 * LCS-backed; emits git-style unified hunks without external packages.
 */

export interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
  /** 1-based line numbers, present for context/remove (a) and context/add (b). */
  aLine?: number;
  bLine?: number;
}

/** Classic dynamic-programming LCS over lines. */
export function diffLines(a: string, b: string): DiffLine[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const m = aLines.length;
  const n = bLines.length;

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        aLines[i] === bLines[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      result.push({ kind: "context", text: aLines[i]!, aLine: i + 1, bLine: j + 1 });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      result.push({ kind: "remove", text: aLines[i]!, aLine: i + 1 });
      i += 1;
    } else {
      result.push({ kind: "add", text: bLines[j]!, bLine: j + 1 });
      j += 1;
    }
  }
  while (i < m) {
    result.push({ kind: "remove", text: aLines[i]!, aLine: i + 1 });
    i += 1;
  }
  while (j < n) {
    result.push({ kind: "add", text: bLines[j]!, bLine: j + 1 });
    j += 1;
  }
  return result;
}

/**
 * Renders a unified-diff-style patch with a configurable context radius.
 */
export function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  a: string,
  b: string,
  contextRadius = 3,
): string[] {
  if (a === b) {
    return [];
  }
  const lines = diffLines(a, b);
  // Indices of changed lines.
  const changed = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) {
    return [];
  }

  // Group changes into hunks with surrounding context.
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - contextRadius);
  let end = Math.min(lines.length - 1, changed[0]! + contextRadius);
  for (const index of changed.slice(1)) {
    if (index - contextRadius > end + 1) {
      hunks.push([start, end]);
      start = Math.max(0, index - contextRadius);
    }
    end = Math.min(lines.length - 1, index + contextRadius);
  }
  hunks.push([start, end]);

  const output: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const [hunkStart, hunkEnd] of hunks) {
    const slice = lines.slice(hunkStart, hunkEnd + 1);
    const aCount = slice.filter((line) => line.kind !== "add").length;
    const bCount = slice.filter((line) => line.kind !== "remove").length;
    const aStart = slice.find((line) => line.kind !== "add")?.aLine ?? 0;
    const bStart = slice.find((line) => line.kind !== "remove")?.bLine ?? 0;
    output.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const line of slice) {
      const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
      output.push(`${prefix}${line.text}`);
    }
  }
  return output;
}
