import { describe, it, expect } from "bun:test";

import { redactObject, redactString } from "@/lib/sentry/redact.js";

describe("redactString", () => {
  it("redacts email addresses", () => {
    expect(redactString("contact alice@example.com today")).toBe(
      "contact [REDACTED] today",
    );
  });

  it("redacts credit-card-shaped digit sequences", () => {
    expect(redactString("card 4111-1111-1111-1111 charged")).toBe(
      "card [REDACTED] charged",
    );
    expect(redactString("card 4111111111111111 charged")).toBe(
      "card [REDACTED] charged",
    );
  });

  it("redacts US SSNs", () => {
    expect(redactString("ssn 123-45-6789 leaked")).toBe(
      "ssn [REDACTED] leaked",
    );
  });

  it("leaves benign strings untouched", () => {
    expect(redactString("hello world")).toBe("hello world");
  });
});

describe("redactObject", () => {
  it("walks nested objects and arrays", () => {
    const input = {
      url: "https://api/?email=alice@example.com",
      headers: ["x-user: bob@example.com"],
      meta: { ssn: "111-22-3333" },
      count: 42,
    };
    expect(redactObject(input)).toEqual({
      url: "https://api/?email=[REDACTED]",
      headers: ["x-user: [REDACTED]"],
      meta: { ssn: "[REDACTED]" },
      count: 42,
    });
  });

  it("passes non-string primitives through", () => {
    expect(redactObject(null)).toBe(null);
    expect(redactObject(undefined)).toBe(undefined);
    expect(redactObject(7)).toBe(7);
    expect(redactObject(true)).toBe(true);
  });
});
