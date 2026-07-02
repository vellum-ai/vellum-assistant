/**
 * Tests for the bash post-execution hook that dispatches Slack DMs
 * for channel verification sessions. Validates that the hook only
 * delivers when an active session exists with a matching destination.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockFindActiveSession = mock((): unknown => null);
mock.module("../channels/gateway-verification-sessions.js", () => ({
  findActiveSession: async () => mockFindActiveSession(),
}));

const mockDeliverVerificationSlack = mock(() => {});
mock.module("../runtime/verification-outbound-actions.js", () => ({
  deliverVerificationSlack: mockDeliverVerificationSlack,
}));

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
  isMultifileApp: mock(() => false),
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
}));
mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));
mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
}));
mock.module("../daemon/doordash-steps.js", () => ({
  isDoordashCommand: mock(() => false),
  updateDoordashProgress: mock(() => {}),
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
// Import after mocks — dynamic import ensures mock.module() calls above
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

async function callWithBashHook(
  command: string,
  content: string,
  isError = false,
): Promise<void> {
  await runPostExecutionSideEffects(
    "bash",
    { command },
    { content, isError },
    dummySideEffectCtx,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bash hook — Slack DM dispatch with session validation", () => {
  beforeEach(() => {
    mockFindActiveSession.mockReset();
    mockDeliverVerificationSlack.mockReset();
    mockLogWarn.mockReset();
    mockLogInfo.mockReset();
    mockLogError.mockReset();
  });

  test("legitimate verification dispatches DM", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U123",
      status: "awaiting_response",
    });

    const output = JSON.stringify({
      _pendingSlackDm: {
        userId: "U123",
        text: "code",
        assistantId: "aid",
      },
    });

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      output,
    );

    expect(mockDeliverVerificationSlack).toHaveBeenCalledTimes(1);
    expect(mockDeliverVerificationSlack).toHaveBeenCalledWith(
      "U123",
      "code",
      "aid",
    );
  });

  test("no active session — DM not dispatched", async () => {
    mockFindActiveSession.mockReturnValue(null);

    const output = JSON.stringify({
      _pendingSlackDm: {
        userId: "U123",
        text: "code",
        assistantId: "aid",
      },
    });

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      output,
    );

    expect(mockDeliverVerificationSlack).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "U123" }),
      expect.stringContaining("no active Slack verification session"),
    );
  });

  test("userId mismatch — DM not dispatched", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U999",
      status: "awaiting_response",
    });

    const output = JSON.stringify({
      _pendingSlackDm: {
        userId: "U_ATTACKER",
        text: "code",
        assistantId: "aid",
      },
    });

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      output,
    );

    expect(mockDeliverVerificationSlack).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "U_ATTACKER", expected: "U999" }),
      expect.stringContaining("does not match active session destination"),
    );
  });

  test("gateway session lookup failure — DM not dispatched (fail closed)", async () => {
    mockFindActiveSession.mockImplementation(() => {
      throw new Error("gateway unreachable");
    });

    const output = JSON.stringify({
      _pendingSlackDm: {
        userId: "U123",
        text: "code",
        assistantId: "aid",
      },
    });

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      output,
    );

    expect(mockDeliverVerificationSlack).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "U123" }),
      expect.stringContaining("gateway session lookup failed"),
    );
  });

  test("command without verification substring — hook is no-op", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U123",
      status: "awaiting_response",
    });

    const output = JSON.stringify({
      _pendingSlackDm: {
        userId: "U123",
        text: "code",
        assistantId: "aid",
      },
    });

    await callWithBashHook("echo hello", output);

    expect(mockDeliverVerificationSlack).not.toHaveBeenCalled();
  });

  test("output without _pendingSlackDm — hook is no-op", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U123",
      status: "awaiting_response",
    });

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      JSON.stringify({ success: true, sessionId: "s1" }),
    );

    expect(mockDeliverVerificationSlack).not.toHaveBeenCalled();
  });

  test("multi-line JSON output — dispatches from correct line", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U123",
      status: "awaiting_response",
    });

    const cancelResult = JSON.stringify({ success: true, cancelled: true });
    const createResult = JSON.stringify({
      _pendingSlackDm: {
        userId: "U123",
        text: "verify-code",
        assistantId: "aid2",
      },
    });
    const multiLineOutput = `${cancelResult}\n${createResult}`;

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      multiLineOutput,
    );

    expect(mockDeliverVerificationSlack).toHaveBeenCalledTimes(1);
    expect(mockDeliverVerificationSlack).toHaveBeenCalledWith(
      "U123",
      "verify-code",
      "aid2",
    );
  });

  test("multi-line — rejected first line does not block valid second line", async () => {
    mockFindActiveSession.mockReturnValue({
      destinationAddress: "U200",
      status: "awaiting_response",
    });

    const staleResult = JSON.stringify({
      _pendingSlackDm: {
        userId: "U100",
        text: "stale-code",
        assistantId: "aid",
      },
    });
    const validResult = JSON.stringify({
      _pendingSlackDm: {
        userId: "U200",
        text: "valid-code",
        assistantId: "aid2",
      },
    });
    const multiLineOutput = `${staleResult}\n${validResult}`;

    await callWithBashHook(
      "assistant channel-verification-sessions create ...",
      multiLineOutput,
    );

    expect(mockDeliverVerificationSlack).toHaveBeenCalledTimes(1);
    expect(mockDeliverVerificationSlack).toHaveBeenCalledWith(
      "U200",
      "valid-code",
      "aid2",
    );
  });
});
