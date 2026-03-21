/**
 * Tests for getExternalAssistantId resolution order.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  delete process.env.VELLUM_ASSISTANT_NAME;
  delete process.env.BASE_DATA_DIR;
});

describe("getExternalAssistantId", () => {
  test("resolves from VELLUM_ASSISTANT_NAME env var", () => {
    process.env.VELLUM_ASSISTANT_NAME = "vellum-cool-eel";
    expect(getExternalAssistantId()).toBe("vellum-cool-eel");
  });

  test("VELLUM_ASSISTANT_NAME takes priority over BASE_DATA_DIR", () => {
    process.env.VELLUM_ASSISTANT_NAME = "vellum-env-eel";
    process.env.BASE_DATA_DIR = "/tmp/vellum/assistants/vellum-path-fox";
    expect(getExternalAssistantId()).toBe("vellum-env-eel");
  });

  test("resolves from BASE_DATA_DIR when env var is not set", () => {
    process.env.BASE_DATA_DIR = "/tmp/vellum/assistants/vellum-true-eel";
    expect(getExternalAssistantId()).toBe("vellum-true-eel");
  });

  test("resolves from BASE_DATA_DIR with trailing slash", () => {
    process.env.BASE_DATA_DIR = "/tmp/vellum/assistants/vellum-cool-heron/";
    expect(getExternalAssistantId()).toBe("vellum-cool-heron");
  });

  test("resolves from BASE_DATA_DIR with Windows-style backslashes", () => {
    process.env.BASE_DATA_DIR =
      "C:\\Users\\user\\.local\\share\\vellum\\assistants\\vellum-nice-fox";
    expect(getExternalAssistantId()).toBe("vellum-nice-fox");
  });

  test("resolves from BASE_DATA_DIR with /instances/<name> path", () => {
    process.env.BASE_DATA_DIR = "/home/user/.vellum/instances/vellum-swift-owl";
    expect(getExternalAssistantId()).toBe("vellum-swift-owl");
  });

  test("resolves from BASE_DATA_DIR with /instances/<name> trailing slash", () => {
    process.env.BASE_DATA_DIR =
      "/home/user/.vellum/instances/vellum-swift-owl/";
    expect(getExternalAssistantId()).toBe("vellum-swift-owl");
  });

  test("falls back to undefined when BASE_DATA_DIR does not match known patterns", () => {
    process.env.BASE_DATA_DIR = "/tmp/some-other-path";
    expect(getExternalAssistantId()).toBe(undefined);
  });

  test("falls back to undefined when nothing is set", () => {
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
