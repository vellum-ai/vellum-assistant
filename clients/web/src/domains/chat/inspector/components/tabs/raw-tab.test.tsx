import { describe, expect, test } from "bun:test";

import { formatPayload, selectResponsePayload } from "./raw-tab";

describe("selectResponsePayload", () => {
  test("surfaces the captured upstream JSON for provider-rejected calls", () => {
    // Error rows persist a synthetic { error, rawResponse } envelope; the Raw
    // tab must show the actual provider payload, not the envelope.
    const persisted = {
      error: { name: "ProviderError", message: "Model not supported" },
      rawResponse: { detail: "Model 'MiniMax-M3' is not supported." },
    };
    expect(selectResponsePayload(persisted)).toEqual({
      detail: "Model 'MiniMax-M3' is not supported.",
    });
  });

  test("passes a non-JSON rawResponse string through verbatim", () => {
    const persisted = {
      error: { name: "ProviderError", message: "Bad gateway" },
      rawResponse: "<html><body>upstream timeout</body></html>",
    };
    expect(selectResponsePayload(persisted)).toBe(
      "<html><body>upstream timeout</body></html>",
    );
  });

  test("leaves a successful response payload untouched", () => {
    const success = { id: "resp_1", choices: [{ message: { content: "hi" } }] };
    expect(selectResponsePayload(success)).toBe(success);
  });

  test("leaves an error payload without a captured body untouched", () => {
    // Retryable (429/5xx) errors aren't captured, so no rawResponse sibling —
    // the Raw tab falls back to showing the synthetic envelope.
    const errorOnly = {
      error: { name: "ProviderError", message: "rate limited" },
    };
    expect(selectResponsePayload(errorOnly)).toBe(errorOnly);
  });

  test("tolerates null/undefined payloads", () => {
    expect(selectResponsePayload(null)).toBe(null);
    expect(selectResponsePayload(undefined)).toBe(undefined);
  });
});

describe("formatPayload", () => {
  test("pretty-prints an object", () => {
    expect(formatPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  test("returns a string body verbatim", () => {
    expect(formatPayload("plain text")).toBe("plain text");
  });
});
