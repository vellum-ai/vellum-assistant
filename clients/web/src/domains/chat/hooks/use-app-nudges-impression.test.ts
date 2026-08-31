/**
 * Pins the banner impression event, which is the denominator the nudge's
 * click-through rate divides by.
 *
 * `showBanner` flips false whenever an interactive surface claims the slot and
 * back once it resolves, so the guard that matters is that a flicker does not
 * bill a second impression. Lives in its own file because the ingest mock has
 * to be installed before the hook module is imported.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import { incrementNativeAppAssistantTurnsSeen } from "@/hooks/use-native-app-nudge";
import type { DisplayMessage } from "@/domains/chat/types/types";

const ingestMock = mock(
  async (_options: { body: unknown; keepalive?: boolean }) => ({
    data: { accepted: 1, persisted: 1, dropped: {} },
    error: undefined,
    response: { ok: true, status: 200 } as Response,
  }),
);
mock.module("@/generated/api/sdk.gen", () => ({
  telemetryIngestCreate: ingestMock,
}));

const { useAppNudges } = await import("@/domains/chat/hooks/use-app-nudges");

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const ORIGINAL_UA = navigator.userAgent;

// A confirmation surface is inherently interactive, so it suppresses every
// nudge while it awaits an answer (LUM-2777).
const AWAITING_CONFIRMATION: DisplayMessage[] = [
  {
    id: "m1",
    role: "assistant",
    surfaces: [{ surfaceId: "s1", surfaceType: "confirmation", data: {} }],
  },
];

function screensFromCalls(): string[] {
  return ingestMock.mock.calls.map((call) => {
    const options = call[0] as {
      body: { events: Array<Record<string, unknown>> };
    };
    return String(options.body.events[0]?.screen ?? "");
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Analytics consent is opt-out, so the emitter is live with no setup here.
  // The gate itself is covered in native-app-nudge-telemetry.test.ts, which
  // sits outside `domains/` and may reach the onboarding store.
  Object.defineProperty(navigator, "userAgent", {
    value: ANDROID_UA,
    configurable: true,
  });
  // The banner is gated behind a minimum turn count; seed past it so the
  // render below is the moment the banner becomes eligible.
  incrementNativeAppAssistantTurnsSeen("generic", 5);
  ingestMock.mockClear();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "userAgent", {
    value: ORIGINAL_UA,
    configurable: true,
  });
});

describe("native app banner impression", () => {
  test("emits once when the banner becomes visible", () => {
    const { result } = renderHook(() => useAppNudges([], 0, null, null));

    expect(result.current.showBanner).toBe(true);
    expect(screensFromCalls()).toEqual(["banner:generic"]);
  });

  test("does not bill a second impression when the banner flickers", () => {
    const { result, rerender } = renderHook(
      ({ messages }: { messages: DisplayMessage[] }) =>
        useAppNudges(messages, 0, null, null),
      { initialProps: { messages: [] as DisplayMessage[] } },
    );

    expect(screensFromCalls()).toEqual(["banner:generic"]);

    rerender({ messages: AWAITING_CONFIRMATION });
    expect(result.current.showBanner).toBe(false);

    rerender({ messages: [] });
    expect(result.current.showBanner).toBe(true);
    expect(screensFromCalls()).toEqual(["banner:generic"]);
  });

  test("emits nothing while the banner is suppressed", () => {
    renderHook(() => useAppNudges(AWAITING_CONFIRMATION, 0, null, null));

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
