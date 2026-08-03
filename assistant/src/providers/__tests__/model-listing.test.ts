import { describe, expect, test } from "bun:test";

import { buildModelListingRequest } from "../model-listing.js";

describe("buildModelListingRequest", () => {
  test("GIVEN gemini WHEN building THEN it targets ListModels with a header-injected key", () => {
    expect(buildModelListingRequest("gemini")).toEqual({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      credentialInjection: { kind: "header", name: "x-goog-api-key" },
    });
  });

  test("GIVEN anthropic WHEN building THEN it sends the required version header", () => {
    expect(buildModelListingRequest("anthropic")).toEqual({
      url: "https://api.anthropic.com/v1/models",
      headers: { "anthropic-version": "2023-06-01" },
      credentialInjection: { kind: "header", name: "x-api-key" },
    });
  });

  test("GIVEN an OpenAI-compatible provider WHEN building THEN it uses a bearer token", () => {
    expect(buildModelListingRequest("openai")).toEqual({
      url: "https://api.openai.com/v1/models",
      credentialInjection: {
        kind: "header",
        name: "authorization",
        prefix: "Bearer ",
      },
    });
  });

  test("GIVEN a connection base URL WHEN building THEN it overrides the provider default", () => {
    expect(
      buildModelListingRequest("openai", "https://proxy.internal/v1/"),
    ).toMatchObject({ url: "https://proxy.internal/v1/models" });
  });

  test("GIVEN a self-hosted provider without a base URL WHEN building THEN there is no request", () => {
    expect(buildModelListingRequest("openai-compatible")).toBeNull();
  });

  test("GIVEN a keyless provider WHEN building THEN there is no request", () => {
    expect(buildModelListingRequest("ollama")).toBeNull();
  });
});
