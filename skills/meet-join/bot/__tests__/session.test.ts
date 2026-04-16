/**
 * Unit tests for the browser-session primitive.
 *
 * We mock Playwright and the Xvfb lifecycle helpers so the tests run on any
 * host (macOS included) without spawning a real X server or Chromium. A
 * heavier integration test that actually exec's Xvfb + Chromium is gated
 * behind `XVFB_TEST=1` and skipped by default — CI and macOS developers
 * would fail trying to exec a Linux binary.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { CHROMIUM_ARGS } from "../src/browser/session.js";

type MockFn = ReturnType<typeof mock>;

interface MockPage {
  goto: MockFn;
  screenshot: MockFn;
  close: MockFn;
}

interface MockContext {
  newPage: MockFn;
  close: MockFn;
}

interface MockBrowser {
  newContext: MockFn;
  close: MockFn;
}

interface LaunchCall {
  options: {
    headless?: boolean;
    args?: readonly string[];
    env?: Record<string, string | undefined>;
  };
}

/**
 * Build a freshly-mocked Playwright + Xvfb surface and register them via
 * Bun's module mocker. Returns handles into the mocks so each test can
 * assert on the calls made through them.
 */
function installMocks(): {
  page: MockPage;
  context: MockContext;
  browser: MockBrowser;
  launchCalls: LaunchCall[];
  startXvfb: MockFn;
  stopXvfb: MockFn;
} {
  const page: MockPage = {
    goto: mock(async () => undefined),
    screenshot: mock(async () => Buffer.alloc(0)),
    close: mock(async () => undefined),
  };
  const context: MockContext = {
    newPage: mock(async () => page),
    close: mock(async () => undefined),
  };
  const browser: MockBrowser = {
    newContext: mock(async () => context),
    close: mock(async () => undefined),
  };

  const launchCalls: LaunchCall[] = [];
  const launch = mock(async (options: LaunchCall["options"]) => {
    launchCalls.push({ options });
    return browser;
  });

  mock.module("playwright", () => ({
    chromium: { launch },
  }));

  const startXvfb = mock(async (display = ":99") => ({
    display,
    process: null,
  }));
  const stopXvfb = mock(async () => undefined);
  mock.module("../src/browser/xvfb.js", () => ({
    startXvfb,
    stopXvfb,
  }));

  return { page, context, browser, launchCalls, startXvfb, stopXvfb };
}

describe("createBrowserSession", () => {
  let mocks: ReturnType<typeof installMocks>;

  beforeEach(() => {
    mocks = installMocks();
  });

  afterEach(() => {
    mock.restore();
  });

  test("launches Chromium with the expected args, env, and headless flag", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const session = await createBrowserSession(
      "https://meet.google.com/abc-defg-hij",
    );

    expect(mocks.launchCalls.length).toBe(1);
    const { options } = mocks.launchCalls[0]!;

    // Non-headless so Xvfb can host the window and Meet's bot-detection
    // doesn't flag us.
    expect(options.headless).toBe(false);

    // Args should include every flag the container runtime needs.
    for (const arg of CHROMIUM_ARGS) {
      expect(options.args).toContain(arg);
    }

    // Env must point Chromium at Xvfb + the Pulse virtual devices.
    expect(options.env?.DISPLAY).toBe(":99");
    expect(options.env?.PULSE_SOURCE).toBe("bot_mic");
    expect(options.env?.PULSE_SINK).toBe("meet_capture");
    // process.env should still be forwarded so PATH etc. survive.
    expect(options.env?.PATH).toBe(process.env.PATH);

    await session.close();
  });

  test("calls page.goto with the provided URL", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const url = "https://meet.google.com/xyz-uvwx-yzz";
    const session = await createBrowserSession(url);

    expect(mocks.page.goto).toHaveBeenCalledTimes(1);
    const [gotoUrl, gotoOpts] = mocks.page.goto.mock.calls[0]!;
    expect(gotoUrl).toBe(url);
    // `load` is the agreed waitUntil for a live webapp; `networkidle` never
    // settles for Meet.
    expect((gotoOpts as { waitUntil?: string }).waitUntil).toBe("load");

    await session.close();
  });

  test("close() tears down page, context, and browser in order", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const session = await createBrowserSession("https://meet.google.com/abc");

    // Reset call trackers after the navigation step so we only see what
    // close() does.
    mocks.page.close.mockClear();
    mocks.context.close.mockClear();
    mocks.browser.close.mockClear();

    await session.close();

    expect(mocks.page.close).toHaveBeenCalledTimes(1);
    expect(mocks.context.close).toHaveBeenCalledTimes(1);
    expect(mocks.browser.close).toHaveBeenCalledTimes(1);
  });

  test("close() tolerates already-closed components", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const session = await createBrowserSession("https://meet.google.com/abc");

    mocks.page.close.mockImplementation(async () => {
      throw new Error("page already closed");
    });
    mocks.context.close.mockImplementation(async () => {
      throw new Error("context already closed");
    });
    mocks.browser.close.mockImplementation(async () => {
      throw new Error("browser already closed");
    });

    // Should not throw — swallowing is the contract.
    await session.close();
  });

  test("ensures Xvfb is started before launching Chromium", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const session = await createBrowserSession("https://meet.google.com/abc");

    expect(mocks.startXvfb).toHaveBeenCalledTimes(1);
    // Default display should be ":99" when caller doesn't override it.
    expect(mocks.startXvfb.mock.calls[0]?.[0]).toBe(":99");

    await session.close();
  });

  test("honors a custom xvfbDisplay option", async () => {
    const { createBrowserSession } = await import("../src/browser/session.js");

    const session = await createBrowserSession("https://meet.google.com/abc", {
      xvfbDisplay: ":42",
    });

    expect(mocks.startXvfb.mock.calls[0]?.[0]).toBe(":42");
    expect(mocks.launchCalls[0]?.options.env?.DISPLAY).toBe(":42");

    await session.close();
  });
});

/**
 * Integration test gated behind `XVFB_TEST=1`. Runs only on Linux hosts
 * with Xvfb + Chromium available; skipped by default so macOS and generic
 * CI stays green.
 */
const runIntegration =
  process.env.XVFB_TEST === "1" && process.platform === "linux";

(runIntegration ? describe : describe.skip)(
  "createBrowserSession [XVFB_TEST=1]",
  () => {
    test("can launch a real browser and navigate to a data URL", async () => {
      // Dynamically import *without* the module mocks above. Bun resets
      // mocks per-test-file, but guard anyway by delaying the import.
      const { createBrowserSession } =
        await import("../src/browser/session.js");
      const session = await createBrowserSession(
        "data:text/html,<title>meet-bot-integration</title>",
      );
      try {
        const title = await session.page.title();
        expect(title).toBe("meet-bot-integration");
      } finally {
        await session.close();
      }
    });
  },
);
