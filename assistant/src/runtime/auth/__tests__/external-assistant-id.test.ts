/**
 * Tests for getExternalAssistantId.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  delete process.env.VELLUM_ASSISTANT_NAME;
});

describe("getExternalAssistantId", () => {
  test("resolves from VELLUM_ASSISTANT_NAME env var", () => {
    process.env.VELLUM_ASSISTANT_NAME = "vellum-cool-eel";
    expect(getExternalAssistantId()).toBe("vellum-cool-eel");
  });

  test("caches the resolved value", () => {
    process.env.VELLUM_ASSISTANT_NAME = "vellum-cool-eel";
    expect(getExternalAssistantId()).toBe("vellum-cool-eel");
    // Change env var — cached value should still be returned
    process.env.VELLUM_ASSISTANT_NAME = "vellum-other-fox";
    expect(getExternalAssistantId()).toBe("vellum-cool-eel");
  });

  test("returns undefined when env var is not set", () => {
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
