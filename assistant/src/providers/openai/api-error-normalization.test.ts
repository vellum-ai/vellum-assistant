import { describe, expect, test } from "bun:test";

import type { NormalizedOpenAIAPIError } from "./api-error-normalization.js";
import { deriveReason } from "./api-error-normalization.js";

function n(over: Partial<NormalizedOpenAIAPIError> = {}): NormalizedOpenAIAPIError {
  return { message: "boom", ...over };
}

describe("deriveReason", () => {
  test("gateway 403 + no_providers_available → model_restricted", () => {
    expect(
      deriveReason(n({ apiErrorType: "no_providers_available" }), 403),
    ).toBe("model_restricted");
  });

  test("403 + RestrictedModelsError param → model_restricted", () => {
    expect(
      deriveReason(n({ apiErrorParam: "RestrictedModelsError" }), 403),
    ).toBe("model_restricted");
  });

  test("403 + RestrictedModelsError in body → model_restricted", () => {
    expect(
      deriveReason(
        n({ message: "boom", rawBody: "RestrictedModelsError: nope" }),
        403,
      ),
    ).toBe("model_restricted");
  });

  test("403 + 'does not have access to this model' prose → model_restricted", () => {
    expect(
      deriveReason(
        n({ message: "You do not have access to this model" }),
        403,
      ),
    ).toBe("model_restricted");
  });

  test("model-not-found prose → model_not_found", () => {
    expect(
      deriveReason(n({ message: "The model gpt-9 does not exist" }), 404),
    ).toBe("model_not_found");
  });

  test("vision-not-supported prose → vision_unsupported", () => {
    expect(
      deriveReason(n({ message: "This model does not support image input" }), 400),
    ).toBe("vision_unsupported");
  });

  test("402 → insufficient_credits", () => {
    expect(deriveReason(n(), 402)).toBe("insufficient_credits");
  });

  test("billing prose → insufficient_credits", () => {
    expect(
      deriveReason(n({ message: "Your credit balance is too low" }), 400),
    ).toBe("insufficient_credits");
  });

  test("401 → invalid_credentials", () => {
    expect(deriveReason(n(), 401)).toBe("invalid_credentials");
  });

  test("plain 403 (no restriction signal) → invalid_credentials", () => {
    expect(deriveReason(n({ message: "Forbidden" }), 403)).toBe(
      "invalid_credentials",
    );
  });

  test("429 → rate_limited", () => {
    expect(deriveReason(n(), 429)).toBe("rate_limited");
  });

  test("529 → overloaded", () => {
    expect(deriveReason(n(), 529)).toBe("overloaded");
  });

  test("overloaded prose (no status) → overloaded", () => {
    expect(deriveReason(n({ message: "Overloaded, try again" }), undefined)).toBe(
      "overloaded",
    );
  });

  test("500 → server_error", () => {
    expect(deriveReason(n(), 500)).toBe("server_error");
  });

  test("generic 400 → bad_request", () => {
    expect(deriveReason(n({ message: "invalid field" }), 400)).toBe(
      "bad_request",
    );
  });

  test("no status, no signal → unknown", () => {
    expect(deriveReason(n({ message: "who knows" }), undefined)).toBe("unknown");
  });
});
