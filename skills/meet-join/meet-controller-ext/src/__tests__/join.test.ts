/**
 * Unit tests for the content-script port of the Meet join flow.
 *
 * We load the committed `meet-dom-prejoin.html` fixture into a JSDOM document
 * and drive {@link runJoinFlow} against it via the `doc` overload. The join
 * flow's job is to orchestrate DOM interactions deterministically; mocking the
 * wait helpers is unnecessary because JSDOM honors the `MutationObserver` we
 * use in `dom/wait.ts`.
 *
 * We follow the testing style of `skills/meet-join/bot/__tests__/join-flow.test.ts`
 * (the Playwright-era predecessor on `main`) — one test per prejoin branch,
 * plus an admission-timeout case. The bot-side test is scheduled for deletion
 * in PR 15 once the content-script flow fully replaces it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { JSDOM } from "jsdom";

import { selectors } from "../dom/selectors.js";
import { runJoinFlow } from "../features/join.js";

/** Path to the committed prejoin fixture. */
const PREJOIN_FIXTURE = pathJoin(
  import.meta.dir,
  "..",
  "dom",
  "__tests__",
  "fixtures",
  "meet-dom-prejoin.html",
);

/** Globals we borrow from the JSDOM window so JSDOM-realm checks pass. */
const JSDOM_GLOBALS = [
  "MutationObserver",
  "Event",
  "HTMLInputElement",
  "HTMLElement",
  "Element",
  "Node",
] as const;

/**
 * Build a JSDOM document from the committed prejoin fixture. Returns the
 * document plus the JSDOM window so tests can scope any additional
 * DOM mutations (e.g. removing the media-permission modal) cleanly.
 */
function loadPrejoinDom(): { dom: JSDOM; doc: Document; win: JSDOM["window"] } {
  const html = readFileSync(PREJOIN_FIXTURE, "utf8");
  // `runScripts: "outside-only"` keeps fixture scripts quiescent while still
  // exposing `window.Event`, `MutationObserver`, etc. inside the document.
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  return { dom, doc: dom.window.document, win: dom.window };
}

// ---------------------------------------------------------------------------
// Global fixtures
// ---------------------------------------------------------------------------
//
// Two concerns are handled globally rather than per-test:
//
//   1. JSDOM realms: `runJoinFlow` reads `MutationObserver` / `Event` from
//      `globalThis`. Bun's runtime doesn't ship with a DOM, so we install
//      those names from a scratch JSDOM window during `beforeAll` and restore
//      the prior globals in `afterAll`. Per-test DOMs reuse the same class
//      constructors because they're identical across fresh JSDOM windows.
//   2. Timeout compression: the production join flow uses 5s / 30s / 90s
//      waits. Those would dominate wall-clock test time. We patch the global
//      `setTimeout` before each test to fire any timer >=500ms immediately,
//      then restore it in `afterEach`. Short timers (reconnect-backoff style)
//      are left untouched so anything keyed on the JS event loop continues
//      to work.

let sharedWindow: JSDOM["window"] | null = null;
const previousGlobals: Record<string, unknown> = {};

beforeAll(() => {
  const dom = new JSDOM("<html><body></body></html>", {
    runScripts: "outside-only",
  });
  sharedWindow = dom.window;
  for (const key of JSDOM_GLOBALS) {
    previousGlobals[key] = (globalThis as unknown as Record<string, unknown>)[
      key
    ];
    (globalThis as unknown as Record<string, unknown>)[key] = (
      sharedWindow as unknown as Record<string, unknown>
    )[key];
  }
});

afterAll(() => {
  for (const key of JSDOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[key] =
      previousGlobals[key];
  }
  sharedWindow = null;
});

// The global `setTimeout` varies across runtimes (`typeof setTimeout` resolves
// to the Node / Bun overload with a `.__promisify__` attachment). Casting
// through `unknown` keeps our collapsing wrapper compatible with the signature
// `runJoinFlow` calls without dragging in a runtime-specific shape.
type GlobalSetTimeout = (
  cb: (...args: unknown[]) => void,
  ms?: number,
  ...args: unknown[]
) => ReturnType<typeof setTimeout>;

let originalSetTimeout: GlobalSetTimeout | null = null;

beforeEach(() => {
  originalSetTimeout = globalThis.setTimeout as unknown as GlobalSetTimeout;
  const patched: GlobalSetTimeout = (cb, ms, ...args) => {
    const real = originalSetTimeout as GlobalSetTimeout;
    // Collapse long production timeouts to a single tick so tests don't spin
    // for 30s / 90s waiting on a selector that will never appear. 500ms is
    // above every short timer in the code under test (there are none today)
    // and below every production timeout we need to collapse.
    if (typeof ms === "number" && ms >= 500) {
      return real(cb, 0, ...args);
    }
    return real(cb, ms, ...args);
  };
  (globalThis as unknown as { setTimeout: GlobalSetTimeout }).setTimeout =
    patched;
});

afterEach(() => {
  if (originalSetTimeout !== null) {
    (globalThis as unknown as { setTimeout: GlobalSetTimeout }).setTimeout =
      originalSetTimeout;
    originalSetTimeout = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attach a click spy to the first element matching `sel` in `doc`. Returns
 * the spy's call list so the test can assert the click landed. The click
 * still propagates through the JSDOM default handler so `dispatchEvent`-style
 * side effects continue to fire.
 */
function spyOnClick(doc: Document, sel: string): string[] {
  const el = doc.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error(`fixture missing selector: ${sel}`);
  const calls: string[] = [];
  const original = el.click.bind(el);
  el.click = () => {
    calls.push(sel);
    original();
  };
  return calls;
}

/**
 * Insert a Meet "Leave call" button into the DOM to simulate admission. We
 * run this *synchronously* before calling {@link runJoinFlow} so the step-5
 * wait short-circuits on the initial `querySelector` check rather than
 * racing against the observer. The separation-of-concerns test goals here
 * are "does the flow locate the leave button?" — not "does the observer fire
 * on a late mutation?" — so pre-insertion is the cleaner assertion target.
 */
function insertLeaveButton(doc: Document): HTMLButtonElement {
  const leave = doc.createElement("button");
  leave.setAttribute("type", "button");
  leave.setAttribute("aria-label", "Leave call");
  leave.textContent = "Leave call";
  doc.body.appendChild(leave);
  return leave as HTMLButtonElement;
}

/**
 * Remove the media-permission modal so step 1 times out (signed-in happy
 * path). Keeping the modal in the fixture is useful for its own test, but
 * every other branch wants the modal-dismissal step to be a no-op.
 */
function removeMediaModal(doc: Document): void {
  const modal = doc.querySelector(selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON);
  const dialog = modal?.closest('[role="dialog"]');
  dialog?.remove();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runJoinFlow (content-script port)", () => {
  test("populates the name input and clicks Join now", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    const clicks = spyOnClick(doc, selectors.PREJOIN_JOIN_NOW_BUTTON);
    insertLeaveButton(doc);

    const events: unknown[] = [];
    await runJoinFlow({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
      meetingId: "mtg-1",
      onEvent: (e) => events.push(e),
      doc,
    });

    // Name input populated with the displayName.
    const input = doc.querySelector(
      selectors.PREJOIN_NAME_INPUT,
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe("Vellum Bot");

    // Join now was clicked exactly once.
    expect(clicks).toEqual([selectors.PREJOIN_JOIN_NOW_BUTTON]);

    // No diagnostic errors on the happy path.
    const errorDiagnostics = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "diagnostic" &&
        (e as { level?: string }).level === "error",
    );
    expect(errorDiagnostics.length).toBe(0);

    // The INGAME_LEAVE_BUTTON selector matches after admission.
    const leave = doc.querySelector(selectors.INGAME_LEAVE_BUTTON);
    expect(leave).not.toBeNull();
  });

  test("falls back to Ask to join when Join now is absent", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Simulate a locked meeting: remove the Join now button so the fallback
    // branch fires.
    doc.querySelector(selectors.PREJOIN_JOIN_NOW_BUTTON)?.remove();
    const clicks = spyOnClick(doc, selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
    insertLeaveButton(doc);

    await runJoinFlow({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
      meetingId: "mtg-2",
      onEvent: () => {},
      doc,
    });

    expect(clicks).toEqual([selectors.PREJOIN_ASK_TO_JOIN_BUTTON]);
  });

  test("dismisses the media-permission modal when Meet renders it", async () => {
    const { doc } = loadPrejoinDom();
    // Modal IS present (keep it) — assert the dismiss click fires.
    const modalClicks = spyOnClick(
      doc,
      selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON,
    );
    const joinClicks = spyOnClick(doc, selectors.PREJOIN_JOIN_NOW_BUTTON);
    insertLeaveButton(doc);

    await runJoinFlow({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
      meetingId: "mtg-3",
      onEvent: () => {},
      doc,
    });

    expect(modalClicks).toEqual([
      selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON,
    ]);
    expect(joinClicks).toEqual([selectors.PREJOIN_JOIN_NOW_BUTTON]);
  });

  test("skips the name fill when the input is not rendered (signed-in flow)", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Signed-in flow: no "Your name" input, but the join buttons are still
    // there.
    doc.querySelector(selectors.PREJOIN_NAME_INPUT)?.remove();
    const clicks = spyOnClick(doc, selectors.PREJOIN_JOIN_NOW_BUTTON);
    insertLeaveButton(doc);

    await runJoinFlow({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      displayName: "Vellum Bot",
      consentMessage: "Hi, Vellum is listening.",
      meetingId: "mtg-4",
      onEvent: () => {},
      doc,
    });

    // No name input means nothing to assert on `.value` — instead verify the
    // flow still clicked Join now, demonstrating the branch didn't fail.
    expect(clicks).toEqual([selectors.PREJOIN_JOIN_NOW_BUTTON]);
  });

  test("emits a diagnostic and rejects when admission times out", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Deliberately do NOT insert a leave button — the INGAME_LEAVE_BUTTON
    // never mounts, so step 5 should reject. The beforeEach setTimeout patch
    // collapses the 90s wait to a single tick so the test runs quickly.

    const events: unknown[] = [];
    await expect(
      runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-5",
        onEvent: (e) => events.push(e),
        doc,
      }),
    ).rejects.toThrow(/in-meeting UI did not appear/i);

    // A diagnostic error was emitted before the throw.
    const diag = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "diagnostic" &&
        (e as { level?: string }).level === "error",
    );
    expect(diag).toBeDefined();
  });
});
