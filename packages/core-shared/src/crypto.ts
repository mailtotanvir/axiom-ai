/**
 * HMAC-SHA256 payload signing shared by the webhook dispatcher (signing) and
 * webhook receivers (verification). Header format:
 *
 *   t=<unix-seconds>,v1=<hex-digest>[,v1=<hex-digest>...]
 *
 * The signed canonical string is `${version}.${timestamp}.${sha256(body)}`,
 * which binds the signature to both time and content without requiring
 * canonical JSON serialization.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "axiom-signature";
export const SIGNATURE_VERSION = "v1";

const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignedPayload {
  headerValue: string;
  timestamp: number;
}

export function signPayload(
  secret: string,
  body: string | Uint8Array,
  options: { timestamp?: number } = {},
): SignedPayload {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const digest = computeDigest(secret, body, timestamp);
  return {
    headerValue: `t=${timestamp},${SIGNATURE_VERSION}=${digest}`,
    timestamp,
  };
}

export function verifySignature(
  secret: string,
  body: string | Uint8Array,
  headerValue: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  const parts = parseHeader(headerValue);
  if (!parts) {
    return false;
  }
  const { timestamp, signatures } = parts;
  if (signatures.length === 0) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(computeDigest(secret, body, timestamp), "utf8");
  return signatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    if (candidateBuffer.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(candidateBuffer, expected);
  });
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(headerValue: string): ParsedHeader | null {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const entry of headerValue.split(",")) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      return null;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      timestamp = parsed;
    } else if (key === SIGNATURE_VERSION) {
      signatures.push(value.toLowerCase());
    }
  }

  if (timestamp === undefined) {
    return null;
  }
  return { timestamp, signatures };
}

function computeDigest(secret: string, body: string | Uint8Array, timestamp: number): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = `${SIGNATURE_VERSION}.${timestamp}.${bodyHash}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}
