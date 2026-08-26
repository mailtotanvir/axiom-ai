#!/usr/bin/env node
/**
 * CI regression gate (O3). Queries the ops plane for the latest eval run
 * of a prompt against a dataset and exits non-zero when it fails.
 *
 *   axiom-eval-gate --ops-url http://localhost:14000 \
 *     --tenant acme --dataset support-golden --prompt support-agent \
 *     --min-score 0.9 [--max-age-minutes 1440]
 */

interface GateResponse {
  passed: boolean;
  score?: number;
  requiredMinScore?: number;
  runId?: string;
  reason?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (key === undefined || value === undefined) {
      continue;
    }
    args[key] = value;
  }
  return args;
}

/** Runs the gate check; returns the process exit code and a report line. */
export async function runGate(
  argv: string[],
): Promise<{ code: number; message: string }> {
  const args = parseArgs(argv);
  const opsUrl = args["ops-url"] ?? "http://localhost:14000";
  const tenant = args.tenant;
  const dataset = args.dataset;
  const prompt = args.prompt;
  const minScore = args["min-score"] ?? "1";

  if (!tenant || !dataset || !prompt) {
    return {
      code: 2,
      message:
        "usage: axiom-eval-gate --tenant T --dataset D --prompt P [--min-score S] [--max-age-minutes M] [--ops-url U]",
    };
  }

  const url =
    `${opsUrl.replace(/\/$/, "")}/v1/evals/gate?tenant=${encodeURIComponent(tenant)}` +
    `&dataset=${encodeURIComponent(dataset)}&prompt=${encodeURIComponent(prompt)}` +
    `&minScore=${encodeURIComponent(minScore)}` +
    (args["max-age-minutes"] !== undefined
      ? `&maxAgeMinutes=${encodeURIComponent(args["max-age-minutes"])}`
      : "");

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return {
      code: 2,
      message: `eval gate unreachable: ${error instanceof Error ? error.message : error}`,
    };
  }

  const body = (await response.json().catch(() => ({}))) as GateResponse;
  if (body.passed === true) {
    return {
      code: 0,
      message: `GATE PASSED: score=${body.score} >= ${body.requiredMinScore} (run ${body.runId})`,
    };
  }
  return {
    code: 1,
    message: `GATE FAILED: ${body.reason ?? `score ${body.score} below ${minScore}`}`,
  };
}

async function main(): Promise<number> {
  const { code, message } = await runGate(process.argv.slice(2));
  if (code === 0) {
    console.log(message);
  } else {
    console.error(message);
  }
  return code;
}

if (process.argv[1]?.endsWith("gate.js") === true || process.argv[1]?.includes("gateCli")) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    });
}
