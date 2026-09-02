/**
 * Pins WHERE the impression is counted: the banner's mount, not the moment it
 * becomes eligible.
 *
 * `ChatBody` drops the banner slot on the empty state
 * (`bannerRendered = !isEmptyState && Boolean(bannerSlot)`) and side-panel chat
 * passes no slot at all, so counting at eligibility billed impressions nobody
 * saw. Mount is the only signal that the banner reached the screen.
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

const { NativeAppBanner } =
  await import("@/components/nudges/native-app-banner");
const { MacOSAppBanner } = await import("@/components/nudges/macos-app-banner");
const { resolveMobilePromotion } = await import("@/hooks/use-native-app-nudge");

function screensFromCalls(): string[] {
  return ingestMock.mock.calls.map((call) => {
    const options = call[0] as {
      body: { events: Array<Record<string, unknown>> };
    };
    return String(options.body.events[0]?.screen ?? "");
  });
}

function renderMobileBanner() {
  render(
    <NativeAppBanner
      promotion={resolveMobilePromotion("ios")}
      onDownload={() => {}}
      onDismiss={() => {}}
    />,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  ingestMock.mockClear();
});

afterEach(cleanup);

describe("banner impression", () => {
  test("counts one impression when the banner mounts", () => {
    renderMobileBanner();

    expect(screensFromCalls()).toEqual(["banner:ios"]);
  });

  test("does not re-count when chat remounts within the session", () => {
    renderMobileBanner();
    cleanup();
    renderMobileBanner();

    expect(screensFromCalls()).toEqual(["banner:ios"]);
  });

  test("counts again once the browser session is new", () => {
    renderMobileBanner();
    cleanup();
    sessionStorage.clear();
    renderMobileBanner();

    expect(screensFromCalls()).toEqual(["banner:ios", "banner:ios"]);
  });

  test("counts the macOS banner against its own target", () => {
    render(<MacOSAppBanner onDownload={() => {}} onDismiss={() => {}} />);

    expect(screensFromCalls()).toEqual(["banner:macos"]);
  });

  test("keeps mobile and macOS impressions independent", () => {
    renderMobileBanner();
    render(<MacOSAppBanner onDownload={() => {}} onDismiss={() => {}} />);

    expect(screensFromCalls()).toEqual(["banner:ios", "banner:macos"]);
  });
});
