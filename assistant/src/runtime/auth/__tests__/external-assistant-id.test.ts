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

// Controllable mock for readLockfile — defaults to null (no lockfile data)
const mockReadLockfile = mock(() => null as Record<string, unknown> | null);

mock.module("../../../util/platform.js", () => ({
  readLockfile: mockReadLockfile,
}));

import {
  getExternalAssistantId,
  resetExternalAssistantIdCache,
} from "../external-assistant-id.js";

afterEach(() => {
  resetExternalAssistantIdCache();
  mockReadLockfile.mockReset();
  mockReadLockfile.mockImplementation(() => null);
  delete process.env.BASE_DATA_DIR;
});

describe("getExternalAssistantId", () => {
  test("resolves from lockfile assistants array (most recently hatched)", () => {
    mockReadLockfile.mockImplementation(() => ({
      assistants: [
        { assistantId: "vellum-old-fox", hatchedAt: "2025-01-01T00:00:00Z" },
        { assistantId: "vellum-new-eel", hatchedAt: "2025-06-15T12:00:00Z" },
      ],
    }));
    expect(getExternalAssistantId()).toBe("vellum-new-eel");
  });

  test("resolves from lockfile with single assistant entry", () => {
    mockReadLockfile.mockImplementation(() => ({
      assistants: [
        { assistantId: "vellum-solo-cat", hatchedAt: "2025-03-01T00:00:00Z" },
      ],
    }));
    expect(getExternalAssistantId()).toBe("vellum-solo-cat");
  });

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

  test("falls back to undefined when BASE_DATA_DIR is not set", () => {
    delete process.env.BASE_DATA_DIR;
    expect(getExternalAssistantId()).toBe(undefined);
  });
});
