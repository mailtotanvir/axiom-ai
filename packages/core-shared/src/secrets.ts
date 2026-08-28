/**
 * Secret scrubbing (X6). Central redaction engine used by every service so
 * that sensitive headers, API keys, and bearer tokens never reach stdout
 * logs or OpenTelemetry span attributes.
 */

/** Attribute/field names that must never be emitted verbatim. */
const SENSITIVE_NAME_FRAGMENTS = [
  "authorization",
  "api-key",
  "apikey",
  "api_key",
  "x-api-key",
  "x-axiom-signature",
  "signature",
  "token",
  "secret",
  "password",
  "cookie",
  "session",
  "credential",
] as const;

/** Header names scrubbed from any serialized request context. */
export const SENSITIVE_HEADERS = [
  "authorization",
  "x-api-key",
  "x-axiom-signature",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
  "proxy-authorization",
] as const;

/** Value patterns that look like credentials even under an innocent key. */
const VALUE_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/gi },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: "groq-key", re: /\bgsk_[A-Za-z0-9]{16,}\b/g },
  { id: "mistral-key", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "hmac-hex", re: /\bsha256=[a-f0-9]{32,}\b/gi },
  { id: "stripe-key", re: /\b(sk|rk)_(test|live)_[A-Za-z0-9]{16,}\b/g },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export const REDACTED = "[REDACTED]";

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** Redact a single string value that may embed credentials. */
export function scrubText(value: string): string {
  let out = value;
  for (const { re } of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** Serialize a headers object with every sensitive header redacted. */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveName(name) ? REDACTED : scrubText(value);
  }
  return out;
}

/**
 * Deep-scrub an arbitrary object (log payloads, span attribute bags):
 * sensitive-named keys are redacted outright, string values are pattern-scrubbed.
 */
export function scrubObject<T>(input: T): T {
  return scrubValue(input) as T;
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveName(key) ? REDACTED : scrubValue(item, depth + 1);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, message2?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SafeLoggerOptions {
  /** Default: process.stdout / process.stderr. Injectable for tests. */
  write?: (line: string) => void;
}

/**
 * Structured JSON-lines logger that scrubs every message and field before
 * writing. All services should log through this instead of console.log so a
 * leaked provider key in an error message cannot reach stdout.
 */
export function createSafeLogger(options: SafeLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const record = {
      level,
      time: new Date().toISOString(),
      message: scrubText(message),
      ...(fields ? (scrubObject(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** Guard used before attaching an attribute to a span. */
export function scrubSpanAttribute(name: string, value: string): string {
  return isSensitiveName(name) ? REDACTED : scrubText(value);
}
