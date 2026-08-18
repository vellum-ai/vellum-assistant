import { describe, expect, test } from "bun:test";

import { logSerializers } from "../log-redact.js";

const {
  err: errSerializer,
  req: reqSerializer,
  res: resSerializer,
} = logSerializers;

// ---------------------------------------------------------------------------
// Bearer token
// ---------------------------------------------------------------------------

describe("bearer token redaction", () => {
  test("redacts a bearer token in a string value", () => {
    const out = reqSerializer({
      headers: { host: "api.example.com", accept: "Bearer eyJhbGci.abc.def" },
    });
    expect(JSON.stringify(out)).not.toContain("eyJhbGci");
    expect(JSON.stringify(out)).toContain("Bearer [REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// API-key patterns - sourced from service-contracts (these were missing from
// the old hardcoded gateway list and are the main motivation for this change)
// ---------------------------------------------------------------------------

describe("API key patterns from service-contracts", () => {
  // Patterns that were MISSING from the old hardcoded gateway list
  test("redacts a Linear API key (lin_api_...)", () => {
    const key = "lin_api_" + "a".repeat(32);
    const out = resSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Notion integration token (ntn_...)", () => {
    const key = "ntn_" + "b".repeat(40);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts an OpenRouter API key (sk-or-v1-...)", () => {
    const key = "sk-or-v1-" + "c".repeat(40);
    const out = reqSerializer({ url: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a PyPI token (pypi-...)", () => {
    const key = "pypi-" + "d".repeat(50);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Fireworks API key (fw_...)", () => {
    const key = "fw_" + "e".repeat(32);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Perplexity API key (pplx-...)", () => {
    const key = "pplx-" + "f".repeat(40);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Tavily API key (tvly-...)", () => {
    const key = "tvly-" + "g".repeat(20);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Firecrawl API key (fc-...)", () => {
    const key = "fc-" + "h".repeat(20);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Slack App token (xapp-...)", () => {
    const key = "xapp-1-ABC12345-9876543210-abcdefghij1234567890";
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Mailgun API key (key-...)", () => {
    const key = "key-" + "a".repeat(32);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts a Twilio API key (SK...)", () => {
    const key = "SK" + "a1b2c3d4e5f6".repeat(3).slice(0, 32);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  // Patterns that were already in the old list (regression guard)
  test("redacts an Anthropic API key (sk-ant-...)", () => {
    const key = "sk-ant-" + "A".repeat(80);
    const out = reqSerializer({ authorization: `Bearer ${key}` });
    expect(JSON.stringify(out)).not.toContain(key);
  });

  test("redacts a GitHub token (ghp_...)", () => {
    const key = "ghp_" + "Z".repeat(36);
    const out = reqSerializer({ body: `token=${key}` });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts an OpenAI project key (sk-proj-...)", () => {
    const key = "sk-proj-" + "X".repeat(40);
    const out = reqSerializer({ body: key });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Sensitive headers - always fully redacted regardless of value
// ---------------------------------------------------------------------------

describe("sensitive header redaction", () => {
  test("redacts authorization header", () => {
    const out = reqSerializer({
      headers: { authorization: "Bearer secret-token" },
    });
    expect((out as Record<string, unknown>).headers).toEqual({
      authorization: "[REDACTED]",
    });
  });

  test("redacts x-api-key header", () => {
    const out = reqSerializer({ headers: { "x-api-key": "my-key-value" } });
    expect((out as Record<string, unknown>).headers).toEqual({
      "x-api-key": "[REDACTED]",
    });
  });

  test("redacts x-vellum-velay-bridge-auth header", () => {
    const out = reqSerializer({
      headers: { "x-vellum-velay-bridge-auth": "bridge-secret-123" },
    });
    expect((out as Record<string, unknown>).headers).toEqual({
      "x-vellum-velay-bridge-auth": "[REDACTED]",
    });
  });

  test("redacts cookie and set-cookie headers", () => {
    const out = reqSerializer({
      headers: {
        cookie: "session=abc123",
        "set-cookie": "session=xyz; HttpOnly",
      },
    });
    const headers = (out as Record<string, unknown>).headers as Record<
      string,
      unknown
    >;
    expect(headers.cookie).toBe("[REDACTED]");
    expect(headers["set-cookie"]).toBe("[REDACTED]");
  });

  test("header name matching is case-insensitive", () => {
    const out = reqSerializer({ headers: { Authorization: "token xyz" } });
    const headers = (out as Record<string, unknown>).headers as Record<
      string,
      unknown
    >;
    expect(headers.Authorization).toBe("[REDACTED]");
  });

  test("non-sensitive headers pass through unchanged", () => {
    const out = reqSerializer({
      headers: { "content-type": "application/json" },
    });
    expect((out as Record<string, unknown>).headers).toEqual({
      "content-type": "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// Deep object / array traversal
// ---------------------------------------------------------------------------

describe("deep value redaction", () => {
  test("redacts secrets nested inside an object", () => {
    const key = "lin_api_" + "x".repeat(32);
    const out = reqSerializer({ outer: { inner: { value: key } } });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  test("redacts secrets inside an array", () => {
    const key = "ghp_" + "Y".repeat(36);
    const out = reqSerializer({ items: [key, "safe-value"] });
    const items = (out as Record<string, unknown>).items as unknown[];
    expect(items[0]).toBe("[REDACTED]");
    expect(items[1]).toBe("safe-value");
  });

  test("stops recursing at depth 8 to prevent stack overflow", () => {
    // Build an object 10 levels deep - beyond the depth cap it returns as-is
    let deep: unknown = "leaf-value";
    for (let i = 0; i < 10; i++) {
      deep = { child: deep };
    }
    // Should not throw; the leaf may survive redaction past depth 8
    expect(() => reqSerializer(deep)).not.toThrow();
  });

  test("non-object, non-string, non-array values pass through unchanged", () => {
    const out = reqSerializer({ count: 42, flag: true, nothing: null });
    expect(out).toEqual({ count: 42, flag: true, nothing: null });
  });
});

// ---------------------------------------------------------------------------
// Error serializer
// ---------------------------------------------------------------------------

describe("err serializer", () => {
  test("extracts name, message, stack from an Error", () => {
    const err = new Error("something broke");
    const out = errSerializer(err) as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(out.message).toBe("something broke");
    expect(typeof out.stack).toBe("string");
  });

  test("redacts a secret embedded in the error message", () => {
    const key = "sk-ant-" + "B".repeat(80);
    const err = new Error(`connection failed: auth=${key}`);
    const out = errSerializer(err) as Record<string, unknown>;
    expect(out.message as string).not.toContain(key);
    expect(out.message as string).toContain("[REDACTED]");
  });

  test("walks the cause chain and redacts secrets in nested causes", () => {
    const key = "ghp_" + "C".repeat(36);
    const cause = new Error(`token=${key}`);
    const err = new Error("outer error", { cause });
    const out = errSerializer(err) as Record<string, unknown>;
    const causeOut = out.cause as Record<string, unknown>;
    expect(causeOut.message as string).not.toContain(key);
    expect(causeOut.message as string).toContain("[REDACTED]");
  });

  test("preserves structured code property on errors", () => {
    const err = Object.assign(new Error("auth failed"), {
      code: "AUTH_EXPIRED",
    });
    const out = errSerializer(err) as Record<string, unknown>;
    expect(out.code).toBe("AUTH_EXPIRED");
  });

  test("preserves extra enumerable properties", () => {
    const err = Object.assign(new Error("oops"), { statusCode: 429 });
    const out = errSerializer(err) as Record<string, unknown>;
    expect(out.statusCode).toBe(429);
  });

  test("non-Error values pass through the err serializer unchanged", () => {
    expect(errSerializer("a string")).toBe("a string");
    expect(errSerializer(null)).toBeNull();
    expect(errSerializer(42)).toBe(42);
  });
});
