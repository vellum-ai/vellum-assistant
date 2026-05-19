import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import {
  _setOverridesForTesting,
  clearFeatureFlagOverridesCache,
} from "../../config/assistant-feature-flags.js";
import { getSqlite, resetDb } from "../../memory/db-connection.js";
import { initializeDb } from "../../memory/db-init.js";
import { recordPerceptionConsentGrant } from "../../perception/consent-grants.js";
import { startPerception, stopPerception } from "../../perception/startup.js";
import { ROUTES } from "./perception-routes.js";

const recentRoute = ROUTES.find(
  (route) => route.operationId === "perception_recent",
);
const publishRoute = ROUTES.find(
  (route) => route.operationId === "perception_publish",
);

if (!recentRoute || !publishRoute) {
  throw new Error("perception routes are not registered");
}

const validEvent = {
  eventId: "evt-test",
  ts: new Date("2026-01-01T00:00:00Z").toISOString(),
  source: { module: "test" },
  payload: {
    kind: "app_focus_changed",
    appId: "com.apple.Safari",
    appName: "Safari",
    windowTitle: "Example",
    redacted: false,
  },
};

describe("perception routes", () => {
  beforeAll(() => {
    resetDb();
    initializeDb();
  });

  beforeEach(() => {
    const sqlite = getSqlite();
    sqlite.run("DELETE FROM perception_consent_grants");
  });

  afterEach(() => {
    stopPerception();
    clearFeatureFlagOverridesCache();
  });

  test("recent route reports disabled when the buffer is not started", () => {
    const result = recentRoute.handler({ queryParams: {} });
    expect(result).toEqual({ enabled: false, entries: [] });
  });

  test("recent route accepts documented query params", () => {
    const result = recentRoute.handler({
      queryParams: {
        windowMs: "300000",
        limit: "20",
        kind: "app_focus_changed",
      },
    });
    expect(result).toEqual({ enabled: false, entries: [] });
  });

  test("recent route rejects invalid query params", () => {
    expect(() =>
      recentRoute.handler({
        queryParams: {
          limit: "0",
        },
      }),
    ).toThrow();
  });

  test("publish route validates events and reports disabled when off", async () => {
    await expect(publishRoute.handler({ body: validEvent })).resolves.toEqual({
      accepted: false,
      reason: "disabled",
    });
  });

  test("publish route rejects malformed events", async () => {
    await expect(
      publishRoute.handler({ body: { junk: true } }),
    ).rejects.toThrow();
  });

  test("publish route stores events when perception is enabled", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    await expect(publishRoute.handler({ body: validEvent })).resolves.toEqual({
      accepted: true,
    });

    const result = recentRoute.handler({ queryParams: { limit: "1" } });
    expect(result).toMatchObject({
      enabled: true,
      entries: [
        {
          event: {
            eventId: "evt-test",
            payload: {
              kind: "app_focus_changed",
              appName: "Safari",
            },
          },
        },
      ],
    });
  });

  test("publish route accepts and redacts screen_snapshot events when consent granted", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();
    recordPerceptionConsentGrant({
      conversationId: "conv-screen",
      eventKind: "screen_snapshot",
    });

    const event = {
      eventId: "evt-screen",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "screen_snapshot",
        conversationId: "conv-screen",
        appId: "com.apple.Safari",
        appName: "Safari",
        windowTitle: "Doc",
        ocrTextRedacted:
          "Project notes: contact user@example.com for apiKey=sk_live_TOPSECRET via https://internal.example.com",
        redacted: false,
        captureMethod: "ocr",
        confidence: 0.8,
      },
    };

    await expect(publishRoute.handler({ body: event })).resolves.toEqual({
      accepted: true,
    });

    const result = recentRoute.handler({
      queryParams: { kind: "screen_snapshot", limit: "1" },
    }) as {
      enabled: boolean;
      entries: Array<{
        event: { payload: { ocrTextRedacted: string } };
      }>;
    };
    const stored = result.entries[0]!.event.payload.ocrTextRedacted;
    expect(stored).toContain("[redacted-email]");
    expect(stored).toContain("[redacted-secret]");
    expect(stored).toContain("[redacted-url]");
    expect(stored).not.toContain("user@example.com");
    expect(stored).not.toContain("sk_live_TOPSECRET");
    expect(stored).not.toContain("https://internal.example.com");
  });

  test("publish route rejects screen_snapshot when consent missing", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    const event = {
      eventId: "evt-screen-no-consent",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "screen_snapshot",
        conversationId: "conv-no-consent",
        appId: "com.apple.Safari",
        appName: "Safari",
        windowTitle: "Doc",
        ocrTextRedacted: "harmless text",
        redacted: false,
        captureMethod: "ocr",
        confidence: 0.8,
      },
    };

    await expect(publishRoute.handler({ body: event })).resolves.toEqual({
      accepted: false,
      reason: "consent_required",
    });
  });

  test("publish route accepts and redacts audio_excerpt events when consent granted", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();
    recordPerceptionConsentGrant({
      conversationId: "conv-audio",
      eventKind: "audio_excerpt",
    });

    const event = {
      eventId: "evt-audio",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "audio_excerpt",
        conversationId: "conv-audio",
        sessionId: "sess-1",
        turnId: "turn-1",
        transcriptRedacted:
          "Send the apiKey=sk_live_AUDIO123 to user@example.com",
        confidence: 0.9,
        language: "en-US",
      },
    };

    await expect(publishRoute.handler({ body: event })).resolves.toEqual({
      accepted: true,
    });

    const result = recentRoute.handler({
      queryParams: { kind: "audio_excerpt", limit: "1" },
    }) as {
      enabled: boolean;
      entries: Array<{
        event: { payload: { transcriptRedacted: string } };
      }>;
    };
    const stored = result.entries[0]!.event.payload.transcriptRedacted;
    expect(stored).toContain("[redacted-email]");
    expect(stored).toContain("[redacted-secret]");
    expect(stored).not.toContain("sk_live_AUDIO123");
    expect(stored).not.toContain("user@example.com");
  });

  test("publish route rejects audio_excerpt when consent missing", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    const event = {
      eventId: "evt-audio-no-consent",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "audio_excerpt",
        conversationId: "conv-no-consent",
        sessionId: "sess-1",
        turnId: "turn-1",
        transcriptRedacted: "hello",
        confidence: 0.9,
      },
    };
    await expect(publishRoute.handler({ body: event })).resolves.toEqual({
      accepted: false,
      reason: "consent_required",
    });
  });

  test("publish route rejects screen_snapshot exceeding the 2048 char cap", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    const event = {
      eventId: "evt-screen-too-big",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "screen_snapshot",
        conversationId: "conv-big",
        appId: "com.apple.Safari",
        appName: "Safari",
        windowTitle: "Doc",
        ocrTextRedacted: "a".repeat(2049),
        redacted: false,
        captureMethod: "ocr",
        confidence: 0.8,
      },
    };
    await expect(publishRoute.handler({ body: event })).rejects.toThrow();
  });

  test("publish route rejects audio_excerpt exceeding the 1024 char cap", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    const event = {
      eventId: "evt-audio-too-big",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "audio_excerpt",
        conversationId: "conv-big-audio",
        sessionId: "sess-1",
        turnId: "turn-1",
        transcriptRedacted: "x".repeat(1025),
        confidence: 0.9,
      },
    };
    await expect(publishRoute.handler({ body: event })).rejects.toThrow();
  });

  test("publish route redacts sensitive strings as defense-in-depth", async () => {
    _setOverridesForTesting({ perception: true });
    startPerception();

    const dirtyEvent = {
      eventId: "evt-dirty",
      ts: new Date("2026-01-01T00:00:00Z").toISOString(),
      source: { module: "test" },
      payload: {
        kind: "app_focus_changed",
        appId: "com.apple.Safari",
        appName: "Safari",
        windowTitle:
          "Inbox - user@example.com - apiKey=sk_live_ABCDEF123456 - https://internal.example.com",
        redacted: false,
      },
    };

    await expect(publishRoute.handler({ body: dirtyEvent })).resolves.toEqual({
      accepted: true,
    });

    const result = recentRoute.handler({ queryParams: { limit: "1" } }) as {
      enabled: boolean;
      entries: Array<{
        event: { payload: { windowTitle: string } };
      }>;
    };
    const stored = result.entries[0]!.event.payload.windowTitle;
    expect(stored).toContain("[redacted-email]");
    expect(stored).toContain("[redacted-secret]");
    expect(stored).toContain("[redacted-url]");
    expect(stored).not.toContain("user@example.com");
    expect(stored).not.toContain("sk_live_ABCDEF123456");
    expect(stored).not.toContain("https://internal.example.com");
  });
});
