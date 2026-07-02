import { describe, expect, test } from "bun:test";

import { deriveFailureError } from "./failure-error.js";

const CODEX_MESSAGE =
  "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.";

const ESC = String.fromCharCode(27); // ANSI escape (0x1B)

// A realistic codex-acp stderr line: a JSON error blob wrapped in a coloured
// log prefix and a trailing reset code.
const ansiCodexStderr =
  `${ESC}[2m2026-06-30T12:00:00Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m codex_core: ` +
  `request failed {"type":"error","status":400,"error":` +
  `{"type":"invalid_request_error","message":"${CODEX_MESSAGE}"}}${ESC}[0m`;

describe("deriveFailureError", () => {
  test("extracts the inner error.message from codex-acp JSON stderr", () => {
    const stderr =
      `{"type":"error","status":400,"error":` +
      `{"type":"invalid_request_error","message":"${CODEX_MESSAGE}"}}`;
    expect(deriveFailureError("Internal error", stderr)).toBe(CODEX_MESSAGE);
  });

  test("strips ANSI codes and extracts error.message from a real log line", () => {
    const result = deriveFailureError("Internal error", ansiCodexStderr);
    expect(result).toBe(CODEX_MESSAGE);
    expect(result).not.toContain(ESC);
  });

  test("parses JSON embedded in surrounding log text", () => {
    const stderr = `2026-06-30 fatal: the adapter said {"error":{"message":"boom"}} and gave up`;
    expect(deriveFailureError("Internal error", stderr)).toBe("boom");
  });

  test("returns the LAST JSON error.message when several are present", () => {
    const stderr =
      `{"error":{"message":"first failure"}}\n` +
      `{"error":{"message":"final failure"}}`;
    expect(deriveFailureError("Internal error", stderr)).toBe("final failure");
  });

  test("empty stderr yields the ack message", () => {
    expect(deriveFailureError("Internal error", "")).toBe("Internal error");
  });

  test("generic ack with informative non-JSON stderr yields the last stderr line, ANSI-stripped", () => {
    const stderr = `starting up...\n${ESC}[31mfatal: could not connect to backend${ESC}[0m`;
    expect(deriveFailureError("Internal error", stderr)).toBe(
      "fatal: could not connect to backend",
    );
  });

  test("already-specific ack is preserved when stderr is empty", () => {
    expect(deriveFailureError(CODEX_MESSAGE, "")).toBe(CODEX_MESSAGE);
  });

  test("already-specific ack is preserved (not double-appended) when stderr duplicates it", () => {
    // codex often echoes the same message to stderr; we must not repeat it.
    expect(deriveFailureError(CODEX_MESSAGE, CODEX_MESSAGE)).toBe(
      CODEX_MESSAGE,
    );
  });

  test("structured error duplicating the generic ack yields the clean ack, not the raw JSON", () => {
    // The adapter acked "Internal error" and also emitted it as a JSON blob;
    // return the clean ack rather than echoing the raw JSON line.
    const stderr = `{"error":{"message":"Internal error"}}`;
    expect(deriveFailureError("Internal error", stderr)).toBe("Internal error");
  });

  test("falls back to the ack message when stderr has no JSON and no lines", () => {
    expect(deriveFailureError("Internal error", "   \n  \n")).toBe(
      "Internal error",
    );
  });

  test("ignores malformed JSON braces and uses the last stderr line", () => {
    const stderr = "noise {not: valid json} more noise\nreal failure detail";
    expect(deriveFailureError("Internal error", stderr)).toBe(
      "real failure detail",
    );
  });

  test("a stray unmatched brace before the JSON does not block extraction", () => {
    const stderr =
      `some log { unmatched brace here\n` +
      `... {"type":"error","error":{"message":"The real error"}} ...`;
    expect(deriveFailureError("Internal error", stderr)).toBe("The real error");
  });

  test("braces inside a JSON string literal don't throw off the scan", () => {
    const stderr = `{"error":{"message":"unexpected } brace {in} the text"}}`;
    expect(deriveFailureError("Internal error", stderr)).toBe(
      "unexpected } brace {in} the text",
    );
  });
});
