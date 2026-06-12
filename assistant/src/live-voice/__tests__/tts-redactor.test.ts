import { describe, expect, test } from "bun:test";

import { redactTextForTts } from "../tts-redactor.js";

describe("redactTextForTts", () => {
  test("redacts Anthropic API keys with the specific placeholder", () => {
    const text = `Your key is sk-ant-api03-${"a".repeat(40)} — keep it safe.`;
    expect(redactTextForTts(text)).toBe(
      "Your key is a redacted Anthropic key — keep it safe.",
    );
  });

  test("redacts OpenAI project keys before the generic sk- rule", () => {
    const text = `Use sk-proj-${"B".repeat(24)} for the project.`;
    expect(redactTextForTts(text)).toBe(
      "Use a redacted API key for the project.",
    );
  });

  test("redacts generic OpenAI keys", () => {
    const text = `sk-${"x1".repeat(12)} is your secret`;
    expect(redactTextForTts(text)).toBe("a redacted API key is your secret");
  });

  test("redacts GitHub fine-grained PATs", () => {
    const text = `token: github_pat_${"A".repeat(82)}`;
    expect(redactTextForTts(text)).toBe("token: a redacted GitHub token");
  });

  test("redacts GitHub classic tokens", () => {
    const text = `ghp_${"a1B2".repeat(9)} expires tomorrow`;
    expect(redactTextForTts(text)).toBe(
      "a redacted GitHub token expires tomorrow",
    );
  });

  test("redacts JWTs", () => {
    const jwt = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    expect(redactTextForTts(`The session token is ${jwt}.`)).toBe(
      "The session token is a redacted token.",
    );
  });

  test("redacts Bearer tokens case-insensitively", () => {
    const text = `Authorization: bearer ${"t0k3n".repeat(5)}`;
    expect(redactTextForTts(text)).toBe(
      "Authorization: a redacted bearer token",
    );
  });

  test("redacts email addresses", () => {
    expect(
      redactTextForTts("Reach me at jane.doe+test@mail.example.co.uk now"),
    ).toBe("Reach me at a redacted email address now");
  });

  test("redacts 16-digit card numbers with and without separators", () => {
    expect(redactTextForTts("Card 4111 1111 1111 1111 on file.")).toBe(
      "Card a redacted card number on file.",
    );
    expect(redactTextForTts("Card 4111-1111-1111-1111 on file.")).toBe(
      "Card a redacted card number on file.",
    );
    expect(redactTextForTts("Card 4111111111111111 on file.")).toBe(
      "Card a redacted card number on file.",
    );
  });

  test("redacts 15-digit Amex-style card numbers", () => {
    expect(redactTextForTts("Amex 3782 822463 10005 charged.")).toBe(
      "Amex a redacted card number charged.",
    );
  });

  test("redacts phone numbers in common formats", () => {
    expect(redactTextForTts("Call (415) 555-0123 today")).toBe(
      "Call a redacted phone number today",
    );
    expect(redactTextForTts("Call +1 415-555-0123 today")).toBe(
      "Call a redacted phone number today",
    );
    expect(redactTextForTts("Call 415.555.0199 today")).toBe(
      "Call a redacted phone number today",
    );
  });

  test("redacts 32-char alphanumeric credentials", () => {
    const key = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
    expect(redactTextForTts(`ElevenLabs key ${key} works`)).toBe(
      "ElevenLabs key a redacted key works",
    );
  });

  test("redacts long hex strings", () => {
    const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    expect(redactTextForTts(`Commit ${sha} merged`)).toBe(
      "Commit a redacted hash merged",
    );
  });

  test("replaces every occurrence, not just the first", () => {
    const text = "Emails: a@example.com and b@example.org";
    expect(redactTextForTts(text)).toBe(
      "Emails: a redacted email address and a redacted email address",
    );
  });

  test("leaves ordinary prose untouched", () => {
    const text =
      "The meeting is at 3pm on June 14, 2026 — room 1234 has 16 seats.";
    expect(redactTextForTts(text)).toBe(text);
  });
});
