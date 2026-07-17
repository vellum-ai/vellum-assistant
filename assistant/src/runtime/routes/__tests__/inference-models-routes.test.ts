/**
 * Tests for the inference model-catalog route handler.
 *
 *   GET /v1/inference/models  — list all catalog models, optional ?provider=
 */

import { describe, expect, test } from "bun:test";

import { PROVIDER_CATALOG } from "../../../providers/model-catalog.js";
import { BadRequestError } from "../errors.js";
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
