/**
 * Pins the Settings card's impression. Without it `settings:<target>` carries
 * clicks and no denominator, so that surface's conversion cannot be computed
 * at all, which is the whole point of splitting `screen` by surface.
 *
 * Own file because the ingest mock has to be installed before the component
 * module is imported.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

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

const { NativeAppCardView } =
  await import("@/domains/settings/components/native-app-card-view");
const { resolveMobilePromotion } = await import("@/hooks/use-native-app-nudge");
const { emitNativeAppNudgeImpressionOnce } =
  await import("@/utils/native-app-nudge-telemetry");

function eventsFromCalls(): Array<Record<string, unknown>> {
  return ingestMock.mock.calls.map((call) => {
    const options = call[0] as {
      body: { events: Array<Record<string, unknown>> };
    };
    return options.body.events[0] ?? {};
  });
}

function renderCard() {
  render(<NativeAppCardView promotion={resolveMobilePromotion("ios")} />);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  ingestMock.mockClear();
});

afterEach(cleanup);

describe("NativeAppCardView impression", () => {
  test("counts an impression against the settings surface on mount", () => {
    renderCard();

    expect(eventsFromCalls()).toMatchObject([
      { step_name: "impression", screen: "settings:ios" },
    ]);
  });

  test("does not re-count when settings remounts within the session", () => {
    renderCard();
    cleanup();
    renderCard();

    expect(eventsFromCalls()).toHaveLength(1);
  });

  test("keeps the settings surface separate from the banner", () => {
    renderCard();

    // The banner's own dedupe key must not have been spent by the card.
    emitNativeAppNudgeImpressionOnce("banner", "ios");

    expect(eventsFromCalls().map((event) => event.screen)).toEqual([
      "settings:ios",
      "banner:ios",
    ]);
  });
});
