/**
 * Tests that managed inference profiles ("quality-optimized", "balanced",
 * "cost-optimized") cannot be edited via the PUT profile route or deleted
 * via the PATCH config route.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

let savedRaw: Record<string, unknown> | null = null;

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => ({
    llm: {
      profiles: {
        "quality-optimized": { provider: "anthropic", model: "claude-sonnet" },
        balanced: { provider: "anthropic", model: "claude-sonnet" },
        "cost-optimized": { provider: "anthropic", model: "claude-haiku" },
        "my-custom": { provider: "openai", model: "gpt-4o" },
      },
    },
  }),
  saveRawConfig: (raw: Record<string, unknown>) => {
    savedRaw = raw;
  },
  deepMergeOverwrite: (
    target: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ) => {
    Object.assign(target, overrides);
  },
}));

import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";

const replaceRoute = ROUTES.find(
  (r) => r.operationId === "config_llm_profiles_replace",
)!;

const patchRoute = ROUTES.find((r) => r.operationId === "config_patch")!;

// ---------------------------------------------------------------------------
// PUT /v1/config/llm/profiles/:name — replace inference profile
// ---------------------------------------------------------------------------

describe("PUT /v1/config/llm/profiles/:name — managed profile guard", () => {
  test("rejects edits to quality-optimized with descriptive message", () => {
    expect(() =>
      replaceRoute.handler({
        pathParams: { name: "quality-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).toThrow(
      'Cannot edit managed profile "quality-optimized". Duplicate it to create a custom profile.',
    );
  });

  test("rejects edits to balanced", () => {
    expect(() =>
      replaceRoute.handler({
        pathParams: { name: "balanced" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects edits to cost-optimized", () => {
    expect(() =>
      replaceRoute.handler({
        pathParams: { name: "cost-optimized" },
        body: { provider: "openai", model: "gpt-4o" },
      }),
    ).toThrow(BadRequestError);
  });

  test("allows edits to a user-defined profile", () => {
    savedRaw = null;
    const result = replaceRoute.handler({
      pathParams: { name: "my-custom" },
      body: { provider: "openai", model: "gpt-4o" },
    });
    expect(result).toEqual({ ok: true });
    expect(savedRaw).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/config — managed profile deletion guard
// ---------------------------------------------------------------------------

describe("PATCH /v1/config — managed profile deletion guard", () => {
  test("rejects deletion of quality-optimized via null with descriptive message", () => {
    expect(() =>
      patchRoute.handler({
        body: { llm: { profiles: { "quality-optimized": null } } },
      }),
    ).toThrow('Cannot delete managed profile "quality-optimized".');
  });

  test("rejects deletion of balanced via null", () => {
    expect(() =>
      patchRoute.handler({
        body: { llm: { profiles: { balanced: null } } },
      }),
    ).toThrow(BadRequestError);
  });

  test("rejects deletion of cost-optimized via null", () => {
    expect(() =>
      patchRoute.handler({
        body: { llm: { profiles: { "cost-optimized": null } } },
      }),
    ).toThrow(BadRequestError);
  });

  test("allows deletion of a user-defined profile via null", () => {
    savedRaw = null;
    const result = patchRoute.handler({
      body: { llm: { profiles: { "my-custom": null } } },
    });
    expect(result).toEqual({ ok: true });
  });

  test("allows non-profile config patches", () => {
    savedRaw = null;
    const result = patchRoute.handler({
      body: { someOtherKey: "value" },
    });
    expect(result).toEqual({ ok: true });
  });

  test("allows patches that modify a managed profile (non-null)", () => {
    savedRaw = null;
    const result = patchRoute.handler({
      body: {
        llm: {
          profiles: { "quality-optimized": { provider: "anthropic" } },
        },
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects nulling the entire profiles map", () => {
    expect(() =>
      patchRoute.handler({
        body: { llm: { profiles: null } },
      }),
    ).toThrow("Cannot null llm.profiles");
  });
});
