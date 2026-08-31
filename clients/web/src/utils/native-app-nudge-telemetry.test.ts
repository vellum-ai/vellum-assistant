/**
 * Exercises the real funnel pipeline (mocking only the generated ingest sdk
 * call, mirroring tips-telemetry.test.ts) so the payload mapping, the
 * `<surface>:<target>` screen encoding, and the consent gate are asserted
 * end-to-end rather than against a stubbed emitter.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

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

const {
  emitNativeAppNudgeEvent,
  emitNativeAppNudgeImpressionOnce,
  NATIVE_APP_NUDGE_FUNNEL_VERSION,
} = await import("@/utils/native-app-nudge-telemetry");

function eventFromCall(callIndex: number): Record<string, unknown> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    { body: { events: Array<Record<string, unknown>> } } | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  return options.body.events[0] ?? {};
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useOnboardingStore.setState({ shareAnalytics: true });
  ingestMock.mockClear();
});

describe("emitNativeAppNudgeEvent", () => {
  it("maps the action to step_name and surface:target to screen", () => {
    emitNativeAppNudgeEvent("click", "banner", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      type: "onboarding",
      step_name: "click",
      step_index: 1,
      screen: "banner:ios",
      funnel_version: NATIVE_APP_NUDGE_FUNNEL_VERSION,
      ab_variant: "control",
    });
  });

  it("gives each action a distinct step index so the funnel nests", () => {
    emitNativeAppNudgeEvent("impression", "banner", "android");
    emitNativeAppNudgeEvent("click", "banner", "android");
    emitNativeAppNudgeEvent("dismiss", "banner", "android");

    expect([0, 1, 2].map((i) => eventFromCall(i).step_index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("distinguishes the settings card from the banner", () => {
    emitNativeAppNudgeEvent("click", "settings", "generic");

    expect(eventFromCall(0).screen).toBe("settings:generic");
  });

  it("carries the macOS target", () => {
    emitNativeAppNudgeEvent("impression", "banner", "macos");

    expect(eventFromCall(0).screen).toBe("banner:macos");
  });

  it("emits nothing when the user has opted out of analytics", () => {
    useOnboardingStore.setState({ shareAnalytics: false });

    emitNativeAppNudgeEvent("click", "banner", "ios");

    expect(ingestMock).not.toHaveBeenCalled();
  });
});

describe("emitNativeAppNudgeImpressionOnce", () => {
  it("emits the first impression for a nudge", () => {
    emitNativeAppNudgeImpressionOnce("banner", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      step_name: "impression",
      screen: "banner:ios",
    });
  });

  it("suppresses a repeat within the same browser session", () => {
    emitNativeAppNudgeImpressionOnce("banner", "ios");
    emitNativeAppNudgeImpressionOnce("banner", "ios");
    emitNativeAppNudgeImpressionOnce("banner", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes per nudge, not globally", () => {
    emitNativeAppNudgeImpressionOnce("banner", "ios");
    emitNativeAppNudgeImpressionOnce("banner", "macos");
    emitNativeAppNudgeImpressionOnce("settings", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(3);
  });

  it("survives a garbage value left in session storage", () => {
    sessionStorage.setItem("nativeAppNudge.impressionsSeen", "not json");

    emitNativeAppNudgeImpressionOnce("banner", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  it("does not spend the dedupe marker while analytics is off", () => {
    useOnboardingStore.setState({ shareAnalytics: false });
    emitNativeAppNudgeImpressionOnce("banner", "ios");
    expect(ingestMock).not.toHaveBeenCalled();

    // Opting in mid-session must not find the nudge already marked seen, or
    // the funnel gets a click with no impression behind it.
    useOnboardingStore.setState({ shareAnalytics: true });
    emitNativeAppNudgeImpressionOnce("banner", "ios");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      step_name: "impression",
      screen: "banner:ios",
    });
  });

  it("still emits when session storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(
      window,
      "sessionStorage",
    ) as PropertyDescriptor;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    try {
      emitNativeAppNudgeImpressionOnce("banner", "ios");
      emitNativeAppNudgeImpressionOnce("banner", "ios");
    } finally {
      Object.defineProperty(window, "sessionStorage", original);
    }

    // Degrades to one per call rather than going silent: a missing impression
    // is worse than a repeated one.
    expect(ingestMock).toHaveBeenCalledTimes(2);
  });
});
