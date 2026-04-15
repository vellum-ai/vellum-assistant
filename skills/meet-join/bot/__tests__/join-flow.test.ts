/**
 * Unit tests for the Meet join flow.
 *
 * We mock Playwright's `Page` entirely rather than driving a real browser
 * (which would need Xvfb + Chromium on every test host). The mock records
 * which selectors were filled, clicked, waited on, etc. so each test can
 * assert that `joinMeet` takes the expected branch and that `postConsentMessage`
 * is invoked with the right arguments.
 */
import { describe, expect, mock, test } from "bun:test";

import { joinMeet } from "../src/browser/join-flow.js";
import { selectors } from "../src/browser/dom-selectors.js";

type MockFn = ReturnType<typeof mock>;

interface FakePage {
  waitForSelector: MockFn;
  fill: MockFn;
  click: MockFn;
  press: MockFn;
  locator: MockFn;
  __locatorCounts: Map<string, number>;
  __locatorCountCalls: string[];
  __waitForSelectorRejectors: Map<string, Error>;
}

/**
 * Build a mock `Page` with configurable behaviors. Each test tweaks the
 * behavior through the returned handles (e.g. by setting a locator count for
 * the "Join now" selector to 0 to force the "Ask to join" branch).
 */
function makePage(): FakePage {
  const locatorCounts = new Map<string, number>();
  // Default: both prejoin buttons + the leave button are present so tests can
  // opt into the "only one branch visible" scenarios by overriding specific
  // entries.
  locatorCounts.set(selectors.PREJOIN_JOIN_NOW_BUTTON, 1);
  locatorCounts.set(selectors.PREJOIN_ASK_TO_JOIN_BUTTON, 1);
  // Chat input: present by default so postConsentMessage skips the toggle
  // click. Tests that want to exercise the "open chat panel" step override
  // this to 0.
  locatorCounts.set(selectors.INGAME_CHAT_INPUT, 1);

  const waitRejectors = new Map<string, Error>();

  const page: FakePage = {
    __locatorCounts: locatorCounts,
    __locatorCountCalls: [],
    __waitForSelectorRejectors: waitRejectors,
    waitForSelector: mock(async (selector: string) => {
      const err = waitRejectors.get(selector);
      if (err) throw err;
      return undefined;
    }),
    fill: mock(async () => undefined),
    click: mock(async () => undefined),
    press: mock(async () => undefined),
    locator: mock((selector: string) => ({
      count: mock(async () => {
        page.__locatorCountCalls.push(selector);
        return locatorCounts.get(selector) ?? 0;
      }),
    })),
  };
  return page;
}

/**
 * Test helper — grab the list of selectors `click` was invoked with, in order.
 */
function clickedSelectors(page: FakePage): string[] {
  return page.click.mock.calls.map((call) => String(call[0]));
}

/**
 * Test helper — grab the list of selectors `waitForSelector` was invoked with.
 */
function waitedSelectors(page: FakePage): string[] {
  return page.waitForSelector.mock.calls.map((call) => String(call[0]));
}

describe("joinMeet", () => {
  test("takes the Join now branch when that button is present", async () => {
    const page = makePage();
    // Both buttons are present by default — Join now should win.
    await joinMeet(page as never, {
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
    });

    // Expected selector order:
    //   1. wait for prejoin name input
    //   2. wait for leave button (signals the bot is in the meeting)
    //   3. wait for chat input (inside postConsentMessage)
    const waits = waitedSelectors(page);
    expect(waits).toContain(selectors.PREJOIN_NAME_INPUT);
    expect(waits).toContain(selectors.INGAME_LEAVE_BUTTON);
    expect(waits).toContain(selectors.INGAME_CHAT_INPUT);

    // Display name was filled into the prejoin input.
    expect(page.fill.mock.calls[0]?.[0]).toBe(selectors.PREJOIN_NAME_INPUT);
    expect(page.fill.mock.calls[0]?.[1]).toBe("Vellum Bot");

    // "Join now" clicked, "Ask to join" NOT clicked.
    const clicks = clickedSelectors(page);
    expect(clicks).toContain(selectors.PREJOIN_JOIN_NOW_BUTTON);
    expect(clicks).not.toContain(selectors.PREJOIN_ASK_TO_JOIN_BUTTON);

    // Chat input was filled with the consent message and submitted.
    const fillCalls = page.fill.mock.calls.map(
      (call) => [String(call[0]), String(call[1])] as const,
    );
    expect(fillCalls).toContainEqual([
      selectors.INGAME_CHAT_INPUT,
      "Hi, Vellum is listening.",
    ]);
    expect(page.press.mock.calls[0]?.[0]).toBe(selectors.INGAME_CHAT_INPUT);
    expect(page.press.mock.calls[0]?.[1]).toBe("Enter");
  });

  test("falls back to Ask to join when Join now is absent", async () => {
    const page = makePage();
    // Simulate a locked meeting: "Join now" is NOT rendered.
    page.__locatorCounts.set(selectors.PREJOIN_JOIN_NOW_BUTTON, 0);

    await joinMeet(page as never, {
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
    });

    const clicks = clickedSelectors(page);
    expect(clicks).toContain(selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
    expect(clicks).not.toContain(selectors.PREJOIN_JOIN_NOW_BUTTON);
  });

  test("opens the chat panel when the composer is not yet mounted", async () => {
    const page = makePage();
    // Simulate a collapsed chat panel: the composer is not rendered until
    // the toggle button is clicked.
    page.__locatorCounts.set(selectors.INGAME_CHAT_INPUT, 0);

    await joinMeet(page as never, {
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
    });

    // The chat panel toggle button must have been clicked before the input
    // was filled.
    const clicks = clickedSelectors(page);
    expect(clicks).toContain(selectors.INGAME_CHAT_PANEL_BUTTON);

    // Chat input was waited for after the toggle clicked — present in the
    // waitForSelector call list.
    const waits = waitedSelectors(page);
    expect(waits).toContain(selectors.INGAME_CHAT_INPUT);
    expect(waits).toContain(selectors.INGAME_CHAT_PANEL_BUTTON);
  });

  test("throws a descriptive error when the in-meeting UI never appears", async () => {
    const page = makePage();
    // Simulate the host never admitting the bot — the leave button never
    // mounts and `waitForSelector` throws.
    page.__waitForSelectorRejectors.set(
      selectors.INGAME_LEAVE_BUTTON,
      new Error("Timeout 90000ms exceeded."),
    );

    await expect(
      joinMeet(page as never, {
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
      }),
    ).rejects.toThrow(/in-meeting UI did not appear/i);
  });

  test("throws a descriptive error when the prejoin name input never appears", async () => {
    const page = makePage();
    page.__waitForSelectorRejectors.set(
      selectors.PREJOIN_NAME_INPUT,
      new Error("Timeout 30000ms exceeded."),
    );

    await expect(
      joinMeet(page as never, {
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
      }),
    ).rejects.toThrow(/prejoin name input did not appear/i);
  });

  test("does not attempt the consent message when the join transition fails", async () => {
    const page = makePage();
    page.__waitForSelectorRejectors.set(
      selectors.INGAME_LEAVE_BUTTON,
      new Error("Timeout 90000ms exceeded."),
    );

    await expect(
      joinMeet(page as never, {
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
      }),
    ).rejects.toThrow();

    // Chat input was never waited for, filled, or submitted.
    const waits = waitedSelectors(page);
    expect(waits).not.toContain(selectors.INGAME_CHAT_INPUT);
    const fillCalls = page.fill.mock.calls.map((call) => String(call[0]));
    expect(fillCalls).not.toContain(selectors.INGAME_CHAT_INPUT);
  });
});
