/**
 * Exercises the real ingest pipeline (mocking only the generated ingest sdk
 * call, mirroring tips-telemetry.test.ts) so the payload mapping — a
 * `type: "billing"` event with step = "plans_viewed" and the source in
 * entry_source — and the consent gate are asserted end-to-end. The URL
 * builders are pure and asserted directly.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import * as sdkGen from "@/generated/api/sdk.gen";

const ingestMock = mock(
  async (_options: { body: unknown; keepalive?: boolean }) => ({
    data: { accepted: 1, persisted: 1, dropped: {} },
    error: undefined,
    response: { ok: true, status: 200 } as Response,
  }),
);
// Spread the real module so this mock stays inert for any test file sharing
// the process — bun's mock.module patches the module registry globally.
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  telemetryIngestCreate: ingestMock,
}));

const { emitPlansEntryViewed } = await import(
  "@/lib/telemetry/plans-entry-telemetry"
);
const { diskPressurePlansSource, plansRouteForSource } = await import(
  "@/lib/telemetry/plans-entry-source"
);

function eventFromCall(callIndex: number): Record<string, unknown> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: { events: Array<Record<string, unknown>> } }
    | undefined;
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

describe("plansRouteForSource", () => {
  it("tags the plans path with the source param", () => {
    expect(plansRouteForSource("out_of_credits")).toBe(
      "/assistant/plans?source=out_of_credits",
    );
  });
});

describe("diskPressurePlansSource", () => {
  it("maps each banner mode to its entry source", () => {
    expect(diskPressurePlansSource("warning")).toBe("disk_pressure_warning");
    expect(diskPressurePlansSource("cleanup")).toBe("disk_pressure_cleanup");
    expect(diskPressurePlansSource("acknowledgement-required")).toBe(
      "disk_pressure_critical",
    );
  });
});

describe("emitPlansEntryViewed", () => {
  it("maps the source to entry_source with a fixed step", () => {
    emitPlansEntryViewed("marketing_pricing");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      type: "billing",
      step: "plans_viewed",
      entry_source: "marketing_pricing",
    });
  });

  it("bounds an open-string source to the serializer's entry_source length", () => {
    emitPlansEntryViewed("x".repeat(100));

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect((eventFromCall(0).entry_source as string).length).toBe(64);
  });

  it("ties events from one page load together with a stable session_id", () => {
    emitPlansEntryViewed("direct");
    emitPlansEntryViewed("out_of_credits");

    expect(eventFromCall(0).session_id).toBe(
      eventFromCall(1).session_id as string,
    );
  });

  it("does not upload when analytics consent is off", () => {
    useOnboardingStore.setState({ shareAnalytics: false });

    emitPlansEntryViewed("direct");

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
