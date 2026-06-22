import { describe, expect, test } from "bun:test";
import { REDACTION_VERSION, redactText } from "./redact";

describe("redactText", () => {
  test("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test+token/value=";
    expect(redactText(input)).toBe("Authorization: Bearer [REDACTED]");
  });

  test("redacts sk-* API keys", () => {
    const input = "Using key sk-abc123def456ghi789jklmnopqrst";
    expect(redactText(input)).toBe("Using key [REDACTED_API_KEY]");
  });

  test("redacts hyphenated sk-* API keys", () => {
    const input = "OPENAI_API_KEY=sk-proj-abc123def456ghi789jklmnopqrst";
    expect(redactText(input)).toBe("OPENAI_API_KEY=[REDACTED_API_KEY]");
  });

  test("redacts email addresses", () => {
    const input = "Contact user.name+tag@example.co.uk for details";
    expect(redactText(input)).toBe("Contact [REDACTED_EMAIL] for details");
  });

  test("redacts /Users/<name>/ paths", () => {
    const input = "Reading /Users/alice/Library/Application Support/config";
    expect(redactText(input)).toBe("Reading ~/Library/Application Support/config");
  });

  test("redacts combined input with multiple patterns", () => {
    const input = [
      "Bearer sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA",
      "email: admin@vellum.ai",
      "path: /Users/dev/src/app",
    ].join("\n");

    const result = redactText(input);
    expect(result).not.toContain("sk-proj");
    // generic-examples:ignore-next-line — reason: testing that redactText masks real-looking emails
    expect(result).not.toContain("admin@vellum.ai");
    expect(result).not.toContain("/Users/dev");
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("[REDACTED_EMAIL]");
    expect(result).toContain("~");
  });

  test("does not false-positive on normal log lines", () => {
    const input = "[2024-01-01 12:00:00] [info] App started";
    expect(redactText(input)).toBe(input);
  });

  test("is idempotent", () => {
    const input =
      "Bearer eyJtoken123 sk-AAAAAAAAAAAAAAAAAAAABBBB user@test.com /Users/alice/docs";
    const once = redactText(input);
    expect(redactText(once)).toBe(once);
  });
});

describe("REDACTION_VERSION", () => {
  test("is exported as 1", () => {
    expect(REDACTION_VERSION).toBe(1);
  });
});
