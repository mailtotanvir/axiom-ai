import { describe, expect, it } from "vitest";

import { signPayload, verifySignature, SIGNATURE_HEADER } from "../src/crypto.js";

const SECRET = "whsec_test_secret_key_material";
const BODY = JSON.stringify({ id: "evt_1", type: "agent.run.completed" });

describe("signPayload / verifySignature", () => {
  it("round-trips a valid signature", () => {
    const { headerValue } = signPayload(SECRET, BODY);
    expect(headerValue).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(verifySignature(SECRET, BODY, headerValue)).toBe(true);
  });

  it("exposes the expected header name", () => {
    expect(SIGNATURE_HEADER).toBe("axiom-signature");
  });

  it("rejects tampered bodies", () => {
    const { headerValue } = signPayload(SECRET, BODY);
    expect(verifySignature(SECRET, `${BODY} `, headerValue)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const { headerValue } = signPayload(SECRET, BODY);
    expect(verifySignature(`${SECRET}-rotated`, BODY, headerValue)).toBe(false);
  });

  it("rejects stale timestamps beyond tolerance", () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const { headerValue } = signPayload(SECRET, BODY, { timestamp: stale });
    expect(verifySignature(SECRET, BODY, headerValue)).toBe(false);
    // ...but accepts them with a wider tolerance window.
    expect(verifySignature(SECRET, BODY, headerValue, 7200)).toBe(true);
  });

  it("rejects malformed headers", () => {
    expect(verifySignature(SECRET, BODY, "")).toBe(false);
    expect(verifySignature(SECRET, BODY, "garbage")).toBe(false);
    expect(verifySignature(SECRET, BODY, "v1=deadbeef")).toBe(false);
    expect(verifySignature(SECRET, BODY, `t=notanumber,v1=${"a".repeat(64)}`)).toBe(false);
  });

  it("is deterministic for identical inputs", () => {
    const timestamp = 1700000000;
    const first = signPayload(SECRET, BODY, { timestamp });
    const second = signPayload(SECRET, BODY, { timestamp });
    expect(first.headerValue).toBe(second.headerValue);
  });
});
