import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ManagedProfileTemplate } from "../config/seed-inference-profiles.js";

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

let mockFetchResult: Record<string, ManagedProfileTemplate> | null = null;

// ---------------------------------------------------------------------------
// Module mocks (must be registered before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../config/managed-profiles-remote.js", () => ({
  fetchManagedProfileTemplates: async () => mockFetchResult,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { resolveManagedTemplatesForSeeding } from "./lifecycle.js";

function templateMap(): Record<string, ManagedProfileTemplate> {
  return {
    balanced: {
      intent: "balanced",
      provider: "anthropic",
      connectionName: "anthropic-managed",
      source: "managed",
      label: "Balanced",
      description: "Good balance",
      maxTokens: 16000,
      effort: "high",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 200000 },
    },
  };
}

describe("resolveManagedTemplatesForSeeding", () => {
  beforeEach(() => {
    mockFetchResult = null;
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns the fetched template map when the platform provides one", async () => {
    const expected = templateMap();
    mockFetchResult = expected;

    const result = await resolveManagedTemplatesForSeeding();

    expect(result).toEqual(expected);
  });

  test("returns undefined (falls back to built-ins) when the fetch returns null", async () => {
    mockFetchResult = null;

    const result = await resolveManagedTemplatesForSeeding();

    expect(result).toBeUndefined();
  });
});
