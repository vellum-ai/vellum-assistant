import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockRouterResult: unknown;
let mockRouterError: Error | undefined;
let mockWorkspaceDir = "/tmp/test-workspace";

const generateAvatarFn = mock(async () => {
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
  generateAvatar: generateAvatarFn,
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
    generateAvatarFn.mockClear();
    mkdirSyncFn.mockClear();
    writeFileSyncFn.mockClear();
    renameSyncFn.mockClear();
  });

  test("successful generation writes PNG and returns success message", async () => {
    const result = await executeAvatar("a friendly purple cat");

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");
    expect(generateAvatarFn).toHaveBeenCalledTimes(1);
  });

  test("empty description returns error", async () => {
    const result = await executeAvatar("");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("description is required");
    expect(generateAvatarFn).not.toHaveBeenCalled();
  });

  test("no image data returned yields error", async () => {
    mockRouterResult = { ...successResult(), imageBase64: "" };

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No image data returned");
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

    const expectedPath = "/tmp/test-workspace/data/avatar/avatar-image.png";

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
