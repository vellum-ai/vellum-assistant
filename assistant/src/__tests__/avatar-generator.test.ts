import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ManagedAvatarError } from "../media/avatar-types.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockRouterResult: unknown;
let mockRouterError: Error | undefined;
let mockWorkspaceDir = "/tmp/test-workspace";

const routedGenerateAvatarFn = mock(async () => {
  if (mockRouterError) throw mockRouterError;
  return mockRouterResult;
});

const mkdirSyncFn = mock(() => {});
const writeFileSyncFn = mock(() => {});
const renameSyncFn = mock(() => {});

// ---------------------------------------------------------------------------
// Mock modules — before importing module under test
// ---------------------------------------------------------------------------

mock.module("../media/avatar-router.js", () => ({
  routedGenerateAvatar: routedGenerateAvatarFn,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("../util/platform.js", () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
}));

mock.module("node:fs", () => ({
  mkdirSync: mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  renameSync: renameSyncFn,
}));

// Import after mocking
import { setAvatarTool } from "../tools/system/avatar-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResult() {
  return {
    imageBase64: "iVBORw0KGgoAAAANSUhEUg==",
    mimeType: "image/png",
    pathUsed: "local" as const,
    correlationId: "test-corr-id",
  };
}

function executeAvatar(description: string) {
  return setAvatarTool.execute(
    { description },
    {} as Parameters<typeof setAvatarTool.execute>[1],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setAvatarTool", () => {
  beforeEach(() => {
    mockRouterResult = successResult();
    mockRouterError = undefined;
    mockWorkspaceDir = "/tmp/test-workspace";
    routedGenerateAvatarFn.mockClear();
    mkdirSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
  });

  test("successful generation writes PNG and returns success message", async () => {
    const result = await executeAvatar("a friendly purple cat");

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");
    expect(routedGenerateAvatarFn).toHaveBeenCalledTimes(1);
  });

  test("empty description returns error", async () => {
    const result = await executeAvatar("");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("description is required");
    expect(routedGenerateAvatarFn).not.toHaveBeenCalled();
  });

  test("no image data returned yields error", async () => {
    mockRouterResult = { ...successResult(), imageBase64: "" };

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No image data returned");
  });

  test("ManagedAvatarError with statusCode 429 returns user-friendly rate limit message", async () => {
    mockRouterError = new ManagedAvatarError({
      code: "some_error_code",
      subcode: "too_many_requests",
      detail: "Rate limited",
      retryable: true,
      correlationId: "corr-rate",
      statusCode: 429,
    });

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rate limited");
  });

  test("ManagedAvatarError with 503 returns service unavailable message", async () => {
    mockRouterError = new ManagedAvatarError({
      code: "avatar_service_error",
      subcode: "upstream_unavailable",
      detail: "Service down",
      retryable: true,
      correlationId: "corr-503",
      statusCode: 503,
    });

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("temporarily unavailable");
  });

  test("ManagedAvatarError with other code returns detail message", async () => {
    mockRouterError = new ManagedAvatarError({
      code: "avatar_content_filtered",
      subcode: "policy_violation",
      detail: "Content was filtered by safety policy",
      retryable: false,
      correlationId: "corr-filter",
      statusCode: 400,
    });

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Content was filtered by safety policy");
  });

  test("generic error returns mapped message", async () => {
    mockRouterError = new Error("Network timeout");

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Image generation failed: Network timeout",
    );
  });

  test("atomic write — file is written to .tmp then renamed", async () => {
    await executeAvatar("a friendly cat");

    const expectedPath = "/tmp/test-workspace/data/avatar/custom-avatar.png";

    // Verify mkdirSync was called for the directory
    expect(mkdirSyncFn).toHaveBeenCalledTimes(1);
    expect((mkdirSyncFn.mock.calls[0] as unknown[])[1]).toEqual({
      recursive: true,
    });

    // Verify writeFileSync writes to a unique tmp path
    expect(writeFileSyncFn).toHaveBeenCalledTimes(1);
    const tmpPath = (writeFileSyncFn.mock.calls[0] as unknown[])[0] as string;
    expect(tmpPath).toStartWith(expectedPath + ".");
    expect(tmpPath).toEndWith(".tmp");

    // Verify renameSync moves tmp to final path
    expect(renameSyncFn).toHaveBeenCalledTimes(1);
    expect((renameSyncFn.mock.calls[0] as unknown[])[0]).toBe(tmpPath);
    expect((renameSyncFn.mock.calls[0] as unknown[])[1]).toBe(expectedPath);
  });
});
