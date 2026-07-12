/**
 * Smoke tests for the inference call-site resolution routes.
 *
 *   GET /v1/inference/callsites        — one row per LLM call site
 *   GET /v1/inference/callsites/:site  — 400 on an unknown site
 */

import { describe, expect, test } from "bun:test";

import { LLMCallSiteEnum } from "../../../config/schemas/llm.js";
import { BadRequestError } from "../errors.js";
import { ROUTES } from "../inference-callsites-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

function handler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function call(operationId: string, args: RouteHandlerArgs): Promise<unknown> {
  return Promise.resolve(handler(operationId)(args));
}

describe("GET inference/callsites", () => {
  test("returns one summary row per call site", async () => {
    const result = (await call("inference_callsites_list", {})) as {
      callSites: { callSite: string; provider: string; model: string }[];
    };
    expect(result.callSites.length).toBe(LLMCallSiteEnum.options.length);
    for (const row of result.callSites) {
      expect(typeof row.provider).toBe("string");
      expect(typeof row.model).toBe("string");
    }
  });
});

describe("GET inference/callsites/:site", () => {
  test("400s on an unknown call site", async () => {
    await expect(
      call("inference_callsites_get", { pathParams: { site: "not-a-site" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
