import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { BadRequestError } from "../errors.js";

let lastGenerateProvider: unknown = null;
let lastGenerateRequest: Record<string, unknown> | null = null;

mock.module("../../../media/image-service.js", () => ({
  generateImage: async (
    provider: unknown,
    _credentials: unknown,
    request: Record<string, unknown>,
  ) => {
    lastGenerateProvider = provider;
    lastGenerateRequest = request;
    return {
      images: [{ mimeType: "image/png", dataBase64: "generated" }],
      resolvedModel: request.model,
    };
  },
  mapImageGenError: () => "mapped",
}));

mock.module("../../../media/image-credentials.js", () => ({
  resolveImageGenRouting: (
    svc: { provider: string },
    _model?: unknown,
  ) => ({
    backendProvider: svc.provider === "openrouter" ? "openrouter" : "gemini",
    managed: false,
  }),
  resolveImageGenCredentials: async () => ({
    credentials: { type: "direct", apiKey: "test-key" },
  }),
}));

const { ROUTES } = await import("../image-generation-routes.js");
const route = ROUTES[0];

beforeEach(() => {
  lastGenerateProvider = null;
  lastGenerateRequest = null;
  setConfig("services", {
    "image-generation": {
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image-preview",
    },
  });
});

describe("image-generation generate route", () => {
  test("mentions OpenRouter in the route description", () => {
    expect(route.description).toContain("OpenRouter");
  });

  test("accepts an arbitrary OpenRouter slug", async () => {
    const result = await route.handler({
      body: {
        prompt: "a nebula",
        model: "black-forest-labs/flux",
      },
    });

    expect(lastGenerateProvider).toBe("openrouter");
    expect(lastGenerateRequest?.model).toBe("black-forest-labs/flux");
    expect(result).toMatchObject({
      resolvedModel: "black-forest-labs/flux",
    });
  });

  test("qualifies a built-in alias for OpenRouter", async () => {
    await route.handler({
      body: { prompt: "a robot", model: "fast" },
    });

    expect(lastGenerateRequest?.model).toBe(
      "google/gemini-3.1-flash-image-preview",
    );
  });

  test("rejects an unknown model when the provider is not OpenRouter", async () => {
    setConfig("services", {
      "image-generation": {
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
    });

    await expect(
      route.handler({
        body: { prompt: "a cat", model: "black-forest-labs/flux" },
      }),
    ).rejects.toThrow(BadRequestError);
    expect(lastGenerateProvider).toBeNull();
  });
});
