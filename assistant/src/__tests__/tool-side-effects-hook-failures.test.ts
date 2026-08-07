/**
 * Tool post-execution side effects: failures in a hook must not surface to the
 * caller.
 *
 * `runPostExecutionSideEffects` runs observation-and-notification work after a
 * tool executor returns, so a hook that throws must be swallowed and logged
 * rather than turning a successful tool call into a failed one.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks: must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Stub out transitive dependencies to prevent import errors
mock.module("../bundler/app-compiler.js", () => ({
  compileApp: mock(() => Promise.resolve({ ok: true })),
}));
mock.module("../media/app-icon-generator.js", () => ({
  generateAppIcon: mock(() => Promise.resolve()),
}));
mock.module("../apps/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => ""),
  getAppsDir: mock(() => ""),
  resolveAppIdFromPath: mock(() => null),
  resolveAppIdByDirName: mock(() => null),
  resolveAppDir: mock(() => ({ dirName: "", dirPath: "" })),
  slugify: mock((s: string) => s),
  validateDirName: mock(() => {}),
  generateAppDirName: mock(() => ""),
  listApps: mock(() => []),
  createApp: mock(() => ({})),
  updateApp: mock(() => {}),
  deleteApp: mock(() => {}),
  getAppPreview: mock(() => null),
  createAppRecord: mock(() => ({})),
  getAppRecord: mock(() => null),
  queryAppRecords: mock(() => []),
  updateAppRecord: mock(() => {}),
  deleteAppRecord: mock(() => {}),
  listAppFiles: mock(() => []),
  appFileExists: mock(() => false),
  readAppFile: mock(() => ""),
  writeAppFile: mock(() => {}),
  editAppFile: mock(() => ({})),
  inlineDistAssets: mock((_, html: string) => html),
  addAppConversationId: mock(() => false),
  linkAppToConversationLineage: mock(() => {}),
}));
mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));
mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
}));
const mockIsDoordashCommand = mock(() => false);
const mockUpdateDoordashProgress = mock(() => {});
mock.module("../daemon/doordash-steps.js", () => ({
  isDoordashCommand: mockIsDoordashCommand,
  updateDoordashProgress: mockUpdateDoordashProgress,
}));

const mockLogWarn = mock((_obj: unknown, _msg: string) => {});
const mockLogInfo = mock((_obj: unknown, _msg: string) => {});
const mockLogError = mock((_obj: unknown, _msg: string) => {});
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: mockLogWarn,
    info: mockLogInfo,
    error: mockLogError,
    debug: () => {},
    trace: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks: dynamic import ensures mock.module() calls above
// are registered before tool-side-effects.ts evaluates its top-level
// `const log = getLogger(...)`.
// ---------------------------------------------------------------------------

import type { SideEffectContext } from "../daemon/tool-side-effects.js";

const { runPostExecutionSideEffects } =
  await import("../daemon/tool-side-effects.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummySideEffectCtx = {
  ctx: {} as SideEffectContext["ctx"],
} satisfies SideEffectContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("doordash progress side effect", () => {
  beforeEach(() => {
    mockIsDoordashCommand.mockReset();
    mockUpdateDoordashProgress.mockReset();
    mockLogError.mockReset();
  });

  test("throwing updateDoordashProgress is swallowed and logged", async () => {
    mockIsDoordashCommand.mockReturnValue(true);
    mockUpdateDoordashProgress.mockImplementation(() => {
      throw new Error("doordash boom");
    });

    await expect(
      runPostExecutionSideEffects(
        "bash",
        { command: "order food" },
        { content: "{}", isError: false },
        dummySideEffectCtx,
      ),
    ).resolves.toBeUndefined();

    expect(mockUpdateDoordashProgress).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash" }),
      expect.stringContaining("DoorDash progress update failed"),
    );
  });
});
