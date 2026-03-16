/**
 * Tests for getExternalAssistantId resolution order.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Default mock: no lockfile data
mock.module("../../../util/platform.js", () => ({
  readLockfile: () => null,
}));

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  delete process.env.BASE_DATA_DIR;
});

describe("getExternalAssistantId", () => {
  test("resolves from BASE_DATA_DIR when lockfile has no data", () => {
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

  test("falls back to undefined when BASE_DATA_DIR does not match /assistants/<name>", () => {
    process.env.BASE_DATA_DIR = "/tmp/some-other-path";
    expect(getExternalAssistantId()).toBe(undefined);
  });

  test("falls back to undefined when BASE_DATA_DIR is not set", () => {
    delete process.env.BASE_DATA_DIR;
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
