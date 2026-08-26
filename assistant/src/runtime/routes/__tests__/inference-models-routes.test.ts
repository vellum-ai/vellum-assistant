/**
 * Tests for the inference model-catalog route handler.
 *
 *   GET /v1/inference/models  — list all catalog models, optional ?provider=
 */

import { afterEach, describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../../../providers/model-catalog.js";
import { BadGatewayError, BadRequestError, NotFoundError } from "../errors.js";
import { ROUTES } from "../inference-models-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function handler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function call(args: RouteHandlerArgs): {
  models: { provider: string; id: string }[];
} {
  return handler("inference_models_list")(args) as {
    models: { provider: string; id: string }[];
  };
}

describe("GET inference/models", () => {
  test("lists every catalog model tagged with its provider", () => {
    const { models } = call({});
    const expected = PROVIDER_CATALOG.reduce(
      (sum, p) => sum + p.models.length,
      0,
    );
    expect(models.length).toBe(expected);
    expect(models.every((m) => typeof m.provider === "string")).toBe(true);
    expect(models.every((m) => typeof m.id === "string")).toBe(true);
  });

  test("filters by provider", () => {
    const provider = PROVIDER_CATALOG[0]!.id;
    const { models } = call({ queryParams: { provider } });
    expect(models.length).toBe(PROVIDER_CATALOG[0]!.models.length);
    expect(models.every((m) => m.provider === provider)).toBe(true);
  });

  test("400s on an unknown provider filter", () => {
    expect(() => call({ queryParams: { provider: "not-a-provider" } })).toThrow(
      BadRequestError,
    );
  });
});

describe("GET inference/models/openrouter/lookup", () => {
  const originalFetch = globalThis.fetch;

  function lookup(args: RouteHandlerArgs) {
    return handler("inference_openrouter_model_lookup")(args);
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("400s when id is missing", async () => {
    await expect(lookup({})).rejects.toBeInstanceOf(BadRequestError);
  });

  test("400s when id is not author/slug", async () => {
    await expect(lookup({ queryParams: { id: "grok-4.6" } })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  test("404s when OpenRouter does not list the id", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 404 })) as typeof fetch;
    await expect(
      lookup({ queryParams: { id: "missing/model" } }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("returns the mapped OpenRouter model", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            id: "openrouter/test-model",
            name: "Vendor: Test Model",
            context_length: 128000,
            top_provider: { max_completion_tokens: 8000 },
            supported_parameters: ["tools"],
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(
      lookup({ queryParams: { id: "openrouter/test-model" } }),
    ).resolves.toEqual({
      id: "openrouter/test-model",
      displayName: "Test Model",
      contextWindowTokens: 128000,
      maxOutputTokens: 8000,
      supportsThinking: false,
    });
  });

  test("502s when OpenRouter is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(
      lookup({ queryParams: { id: "openrouter/test-model" } }),
    ).rejects.toBeInstanceOf(BadGatewayError);
  });
});
