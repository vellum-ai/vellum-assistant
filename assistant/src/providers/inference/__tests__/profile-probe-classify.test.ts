import { describe, expect, test } from "bun:test";

import { ProviderError } from "../../../util/errors.js";
import { classifyProbeFailure } from "../profile-probe.js";

describe("classifyProbeFailure", () => {
  test("blames the provider connection for a rejected credential", () => {
    const result = classifyProbeFailure(
      new ProviderError("401 invalid api key", "openai-compatible", 401, {
        reason: "invalid_credentials",
      }),
    );
    expect(result.blame).toBe("provider");
    expect(result.reason).toBe("invalid_credentials");
  });

  test("blames the profile for an unknown model", () => {
    const result = classifyProbeFailure(
      new ProviderError("model does not exist", "openai-compatible", 404, {
        reason: "model_not_found",
      }),
    );
    expect(result.blame).toBe("profile");
  });

  test("blames the profile for an impossible token budget", () => {
    const result = classifyProbeFailure(
      new ProviderError(
        "ContextWindowExceededError: maximum context length is 300000 tokens",
        "openai-compatible",
        400,
        { reason: "context_overflow" },
      ),
    );
    expect(result.blame).toBe("profile");
    expect(result.detail).toContain("300000");
  });

  test("marks rate limits as transient", () => {
    expect(
      classifyProbeFailure(
        new ProviderError("429", "openai", 429, { reason: "rate_limited" }),
      ).blame,
    ).toBe("transient");
  });

  test("blames the provider for transport failures", () => {
    // The adapters stamp reason network_error on SDK connection errors
    // (normalizeOpenAIAPIError), so the probe classifies by reason alone.
    const result = classifyProbeFailure(
      new ProviderError(
        "OpenAI-compatible API error (unknown status): Connection error.",
        "openai-compatible",
        undefined,
        { reason: "network_error" },
      ),
    );
    expect(result.blame).toBe("provider");
    expect(result.reason).toBe("network_error");
  });

  test("falls back to unknown for unclassified errors", () => {
    expect(classifyProbeFailure(new Error("boom")).blame).toBe("unknown");
    expect(classifyProbeFailure(new Error("boom")).detail).toBe("boom");
  });
});
