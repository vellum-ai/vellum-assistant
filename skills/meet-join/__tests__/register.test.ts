/**
 * Tests for `skills/meet-join/register.ts`.
 *
 * The register module is a pure side-effect: importing it pushes every
 * meet_* tool onto the assistant's external-tool registry when the
 * `meet` feature flag is on. Without this bootstrap, the daemon's
 * `initializeTools()` never sees the meet tools and they remain
 * invisible to the LLM. These assertions guard that invariant — if
 * a meet tool is added/renamed/removed, this test catches the drift
 * before the tool silently disappears from production.
 *
 * Test strategy: we mock `registerExternalTools` so we can capture
 * exactly what the bootstrap call registers without pulling in the
 * whole assistant tool-registry module graph (which would force us
 * to stand up SQLite, credential storage, etc. just to assert a tool
 * list). The real integration from register.ts → tool-manifest.ts is
 * thin enough that a pure-call assertion here is sufficient.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

// Module-scope state so each test can tweak inputs without re-installing mocks.
let flagEnabled = true;
let captured: Array<{ name: string }> | null = null;

mock.module("../../../assistant/src/tools/tool-manifest.js", () => ({
  registerExternalTools: (tools: Array<{ name: string }>) => {
    captured = tools.map((t) => ({ name: t.name }));
  },
}));

mock.module(
  "../../../assistant/src/config/assistant-feature-flags.js",
  () => ({
    isAssistantFeatureFlagEnabled: (key: string) => {
      if (key === "meet") return flagEnabled;
      return true;
    },
  }),
);

mock.module("../../../assistant/src/config/loader.js", () => ({
  getConfig: () => ({}),
}));

// Stub the session manager — register.ts does not invoke it, but the
// meet tool modules import it at evaluation time, so the mock keeps
// module loading cheap and side-effect-free.
mock.module("../daemon/session-manager.js", () => ({
  MeetSessionManager: {
    activeSessions: () => [],
    getSession: () => null,
    join: async () => {
      throw new Error("join not used in register tests");
    },
    leave: async () => {},
    sendChat: async () => {},
    speak: async () => ({ streamId: "unused" }),
    cancelSpeak: async () => {},
    enableAvatar: async () => ({ enabled: true }),
    disableAvatar: async () => ({ disabled: true }),
  },
  MeetSessionNotFoundError: class extends Error {
    readonly name = "MeetSessionNotFoundError";
  },
  MeetSessionUnreachableError: class extends Error {
    readonly name = "MeetSessionUnreachableError";
  },
  MeetBotAvatarError: class extends Error {
    readonly name = "MeetBotAvatarError";
  },
  MeetBotChatError: class extends Error {
    readonly name = "MeetBotChatError";
  },
}));

mock.module("../meet-config.js", () => ({
  getMeetConfig: () => ({
    consentMessage: "test-consent",
  }),
}));

mock.module("../../../assistant/src/daemon/identity-helpers.js", () => ({
  getAssistantName: () => "TestAssistant",
}));

mock.module("../../../assistant/src/util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const EXPECTED_TOOL_NAMES = [
  "meet_cancel_speak",
  "meet_disable_avatar",
  "meet_enable_avatar",
  "meet_join",
  "meet_leave",
  "meet_send_chat",
  "meet_speak",
];

// Flag must be true BEFORE the initial import — register.ts runs its
// side effect at module-load time, and the ESM cache means we only get
// one shot at observing the call.
flagEnabled = true;

// Evaluate register.ts once at top level so the assertions below see
// the exact call made at production module-load time. Subsequent
// imports hit the ESM cache and do not re-run the side effect.
await import("../register.js");

// Snapshot the captured tools so later mutations to the `captured`
// module-scope variable (via beforeEach in other describe blocks or
// stray test cleanup) cannot invalidate these assertions.
const registeredAtImport: Array<{ name: string }> | null = captured
  ? [...captured]
  : null;

afterAll(() => {
  mock.restore();
});

describe("meet-join register", () => {
  test("registers every meet_* tool when the meet flag is on", () => {
    expect(registeredAtImport).not.toBeNull();
    const registeredNames = (registeredAtImport ?? [])
      .map((t) => t.name)
      .sort();

    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(registeredNames).toContain(expected);
    }

    // Exactly 7 distinct meet_* tools are expected. A count mismatch is
    // a signal to update the plan and related tests, not to silently
    // accept the drift.
    const meetTools = registeredNames.filter((n) => n.startsWith("meet_"));
    expect(new Set(meetTools).size).toBe(EXPECTED_TOOL_NAMES.length);
  });
});
