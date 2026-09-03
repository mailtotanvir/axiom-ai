import { describe, expect, it } from "vitest";
import {
  REDACTED,
  createSafeLogger,
  scrubHeaders,
  scrubObject,
  scrubSpanAttribute,
  scrubText,
  SENSITIVE_HEADERS,
} from "../src/secrets.js";

describe("scrubText", () => {
  it("redacts bearer tokens", () => {
    expect(scrubText("auth Bearer abc123def456ghi")).not.toContain("abc123def456ghi");
    expect(scrubText("auth Bearer abc123def456ghi")).toContain(REDACTED);
  });

  it("redacts OpenAI-style keys", () => {
    const out = scrubText("failed call with sk-proj-abcdefgh1234567890ab");
    expect(out).not.toContain("sk-proj-abcdefgh1234567890ab");
  });

  it("redacts Groq-style keys", () => {
    const out = scrubText("key gsk_abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("gsk_abcdefghijklmnopqrstuvwx");
  });

  it("redacts HMAC signatures", () => {
    const sig = `sha256=${"a".repeat(64)}`;
    expect(scrubText(`sig=${sig}`)).not.toContain(sig);
  });

  it("redacts AWS access keys and stripe keys", () => {
    expect(scrubText("AKIAIOSFODNN7EXAMPLE")).toContain(REDACTED);
    expect(scrubText("sk_test_abcdefghijklmnopqr")).toContain(REDACTED); // gitleaks:allow - synthetic fixture asserting redaction
  });

  it("redacts PEM private key blocks", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----`;
    expect(scrubText(`pem: ${pem}`)).not.toContain("MIIEvQ");
  });

  it("leaves ordinary text untouched", () => {
    const text = "gateway routed request to provider groq in 42ms";
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubHeaders", () => {
  it("redacts sensitive header values verbatim", () => {
    const out = scrubHeaders({
      authorization: "Bearer super-secret-token",
      "x-axiom-signature": "sha256=deadbeef",
      "content-type": "application/json",
    });
    expect(out.authorization).toBe(REDACTED);
    expect(out["x-axiom-signature"]).toBe(REDACTED);
    expect(out["content-type"]).toBe("application/json");
  });

  it("covers the canonical sensitive header list", () => {
    const headers = Object.fromEntries(SENSITIVE_HEADERS.map((h) => [h, "value"]));
    const out = scrubHeaders(headers);
    for (const header of SENSITIVE_HEADERS) {
      expect(out[header]).toBe(REDACTED);
    }
  });
});

describe("scrubObject", () => {
  it("redacts sensitive-named keys at any depth", () => {
    const out = scrubObject({
      tenantId: "t-1",
      request: {
        headers: { authorization: "Bearer xyz", "x-api-key": "key-123" },
        config: { apiKey: "sk-proj-abcdefgh1234567890ab" }, // gitleaks:allow - synthetic fixture asserting redaction
      },
    });
    expect(JSON.stringify(out)).not.toContain("sk-proj-abcdefgh1234567890ab");
    expect(JSON.stringify(out)).not.toContain("Bearer xyz");
    expect((out as Record<string, unknown>).tenantId).toBe("t-1");
  });

  it("scrubs credential-looking values inside innocent fields", () => {
    const out = scrubObject({ note: "using gsk_abcdefghijklmnopqrstuvwx today" });
    expect((out as Record<string, unknown>).note).not.toContain("gsk_");
  });

  it("handles arrays and nulls", () => {
    const out = scrubObject({ items: [{ token: "t" }, null, 5] });
    expect(JSON.stringify(out)).not.toContain('"t"');
  });
});

describe("createSafeLogger", () => {
  it("never writes secrets to the output stream", () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (line) => lines.push(line) });
    logger.info("upstream rejected request", {
      authorization: "Bearer live-secret",
      apiKey: "sk-proj-abcdefgh1234567890ab", // gitleaks:allow - synthetic fixture asserting redaction
      detail: "Bearer fallback-token-123456",
      tenant: "t-1",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("live-secret");
    expect(joined).not.toContain("sk-proj-abcdefgh1234567890ab");
    expect(joined).not.toContain("fallback-token-123456");
    expect(joined).toContain('"tenant":"t-1"');
    const parsed = JSON.parse(lines[0]) as { level: string; message: string };
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("upstream rejected request");
  });

  it("scrubs error messages logged at error level", () => {
    const lines: string[] = [];
    const logger = createSafeLogger({ write: (line) => lines.push(line) });
    logger.error(new Error("unauthorized for key gsk_abcdefghijklmnopqrstuvwx").message);
    expect(lines.join()).not.toContain("gsk_abcdefghijklmnopqrstuvwx");
  });
});

describe("scrubSpanAttribute", () => {
  it("redacts sensitive attribute names outright", () => {
    expect(scrubSpanAttribute("http.request.header.authorization", "Bearer abc")).toBe(REDACTED);
  });

  it("pattern-scrubs credential-looking values", () => {
    expect(scrubSpanAttribute("error.message", "bad key sk-abcdefgh123456789")).not.toContain("sk-abcdefgh123456789");
  });
});
