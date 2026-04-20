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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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

/** Path to the committed ingame fixture. */
const INGAME_FIXTURE = pathJoin(
  import.meta.dir,
  "..",
  "dom",
  "__tests__",
  "fixtures",
  "meet-dom-ingame.html",
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
 * Insert the post-admission bottom toolbar buttons — the "Leave call" button
 * AND the mic toggle — into the DOM to simulate admission. We run this
 * *synchronously* before calling {@link runJoinFlow} so the step-5 wait
 * short-circuits on the initial `querySelector` check rather than racing
 * against the observer. The separation-of-concerns test goals here are
 * "does the flow locate the in-meeting UI?" — not "does the observer fire
 * on a late mutation?" — so pre-insertion is the cleaner assertion target.
 *
 * The mic toggle is what `runJoinFlow` step 5 actually waits on
 * (`INGAME_READY_INDICATOR`); the leave button is kept alongside it so the
 * post-admission fixture mirrors live Meet (which renders both). Omitting
 * the mic toggle is how {@link insertLeaveButtonOnly} below simulates the
 * original bug: Meet's leave button mounts in the waiting room too, so the
 * bot-side code used to short-circuit step 5 before actual admission.
 */
function insertPostAdmissionToolbar(doc: Document): {
  leave: HTMLButtonElement;
  micToggle: HTMLButtonElement;
} {
  const leave = doc.createElement("button");
  leave.setAttribute("type", "button");
  leave.setAttribute("aria-label", "Leave call");
  leave.textContent = "Leave call";
  doc.body.appendChild(leave);

  const micToggle = doc.createElement("button");
  micToggle.setAttribute("type", "button");
  micToggle.setAttribute("aria-label", "Turn off microphone");
  micToggle.textContent = "Microphone";
  doc.body.appendChild(micToggle);

  return {
    leave: leave as HTMLButtonElement,
    micToggle: micToggle as HTMLButtonElement,
  };
}

/**
 * Insert ONLY a "Leave call" button — simulating the waiting-room surface
 * that previously caused step 5 to short-circuit before actual admission.
 * Used by the regression test below to pin that the join flow no longer
 * treats a lone leave button as an admission signal.
 */
function insertLeaveButtonOnly(doc: Document): HTMLButtonElement {
  const leave = doc.createElement("button");
  leave.setAttribute("type", "button");
  leave.setAttribute("aria-label", "Leave call");
  leave.textContent = "Leave call";
  doc.body.appendChild(leave);
  return leave as HTMLButtonElement;
}

/**
 * Splice the contents of the committed ingame fixture into `doc.body` so
 * `runJoinFlow` step 5's `waitForSelector(INGAME_READY_INDICATOR)` resolves
 * by observing the real fixture DOM (rather than a synthesized toolbar).
 *
 * This gives us one test that asserts against live, committed markup:
 * if the ingame fixture is ever recaptured and happens to drop the mic
 * toggle without updating `INGAME_READY_INDICATOR`, this test fails
 * alongside the selector fixture-pin, making drift loud.
 */
function spliceIngameFixture(doc: Document): void {
  const html = readFileSync(INGAME_FIXTURE, "utf8");
  const ingameDom = new JSDOM(html);
  // Move every node under the ingame <body> into `doc.body` so the post-
  // admission surfaces become visible to `runJoinFlow`'s selectors.
  const ingameBody = ingameDom.window.document.body;
  for (const node of Array.from(ingameBody.childNodes)) {
    doc.body.appendChild(doc.importNode(node, true));
  }
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

/**
 * Inject the minimal chat DOM (message list + composer textarea + send button)
 * into `doc` so step 6's {@link postConsentMessage} call can locate everything
 * it needs. Mounting the message list short-circuits `ensurePanelOpen`, so no
 * panel-toggle click is required.
 *
 * Returns the mounted textarea and send button so individual tests can spy on
 * their state after the join completes.
 */
function insertChatSurface(doc: Document): {
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
} {
  const list = doc.createElement("div");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Chat messages");
  doc.body.appendChild(list);

  const input = doc.createElement("textarea");
  input.setAttribute("aria-label", "Send a message");
  doc.body.appendChild(input);

  const sendButton = doc.createElement("button");
  sendButton.setAttribute("type", "button");
  sendButton.setAttribute("aria-label", "Send a message");
  sendButton.textContent = "Send";
  doc.body.appendChild(sendButton);

  return {
    input: input as HTMLTextAreaElement,
    sendButton: sendButton as HTMLButtonElement,
  };
}

/**
 * Install `doc` (and its owning window) as the process-wide `document` /
 * `window` so `chat.ts`'s bare `document` references resolve to the test
 * fixture. Returns a restore function the test should call in cleanup.
 *
 * `postConsentMessage` lives in `chat.ts`, which operates on the global
 * `document` (there's no `doc` overload for the chat helpers). Bun's runtime
 * has no DOM, so without this wiring the call crashes with a ReferenceError.
 */
function installGlobalDoc(doc: Document): () => void {
  const win = (doc as unknown as { defaultView: Window }).defaultView;
  // Mirror the chat.test.ts harness: `chat.ts` references the textarea
  // prototype's native `value` setter (the React-controlled-input
  // bypass), so tests that drive `postConsentMessage` via the full join
  // flow must expose jsdom's `HTMLTextAreaElement` / `Event` / `window`
  // on `globalThis`. Without this, `Object.getOwnPropertyDescriptor(
  // HTMLTextAreaElement.prototype, 'value')` resolves against Bun's
  // bare runtime (where HTMLTextAreaElement may be unavailable or
  // prototype-incompatible with the jsdom instance), the native setter
  // call no-ops, and the composer stays empty.
  const keys = [
    "document",
    "window",
    "Event",
    "HTMLTextAreaElement",
    "HTMLButtonElement",
    "MutationObserver",
  ] as const;
  const prev: Partial<Record<(typeof keys)[number], unknown>> = {};
  for (const k of keys) {
    prev[k] = (globalThis as Record<string, unknown>)[k];
  }
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = win;
  const winRec = win as unknown as Record<string, unknown>;
  (globalThis as Record<string, unknown>).Event = winRec.Event;
  (globalThis as Record<string, unknown>).HTMLTextAreaElement =
    winRec.HTMLTextAreaElement;
  (globalThis as Record<string, unknown>).HTMLButtonElement =
    winRec.HTMLButtonElement;
  (globalThis as Record<string, unknown>).MutationObserver =
    winRec.MutationObserver;
  return () => {
    for (const k of keys) {
      const v = prev[k];
      if (v === undefined) {
        delete (globalThis as Record<string, unknown>)[k];
      } else {
        (globalThis as Record<string, unknown>)[k] = v;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runJoinFlow (content-script port)", () => {
  test("populates the name input and clicks Join now", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    const clicks = spyOnClick(doc, selectors.PREJOIN_JOIN_NOW_BUTTON);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-1",
        onEvent: (e) => events.push(e),
        doc,
      });
    } finally {
      restore();
    }

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

  test("emits a trusted_click message with computed screen coords before clicking", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    // Stub the admission button's geometry so the coordinate math is
    // deterministic — jsdom returns zero rects by default.
    const btn = doc.querySelector(
      selectors.PREJOIN_JOIN_NOW_BUTTON,
    ) as HTMLElement;
    btn.getBoundingClientRect = () =>
      ({
        left: 900,
        top: 500,
        width: 200,
        height: 40,
        right: 1100,
        bottom: 540,
        x: 900,
        y: 500,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-click-coords",
        onEvent: (e) => events.push(e),
        doc,
        // window with explicit chrome offset: chrome=100px tall, at screen
        // origin (0,0). Expected screen coords = center of the stubbed rect
        // plus chrome offset: x = 900+100 = 1000, y = 500+100+20 = 620.
        window: {
          screenX: 0,
          screenY: 0,
          outerHeight: 820,
          innerHeight: 720,
        },
      });
    } finally {
      restore();
    }

    const trustedClick = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "trusted_click",
    ) as { type: string; x: number; y: number } | undefined;
    expect(trustedClick).toBeDefined();
    expect(trustedClick!.x).toBe(1000);
    expect(trustedClick!.y).toBe(620);
  });

  test("trusted_click adds window screenX/screenY when the window is not at screen origin", async () => {
    // Exercises a second monitor / tiled window scenario: the browser
    // window sits at (screenX=150, screenY=80) relative to the X screen
    // origin. The admission button's screen coordinates must include that
    // offset, otherwise xdotool would click empty space at (clientX,
    // clientY) on the wrong monitor. Production Xvfb always pins the
    // window to 0,0 so this case is not hit today, but a desktop Chromium
    // run (e.g. for a developer repro) could land here.
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    const btn = doc.querySelector(
      selectors.PREJOIN_JOIN_NOW_BUTTON,
    ) as HTMLElement;
    btn.getBoundingClientRect = () =>
      ({
        left: 900,
        top: 500,
        width: 200,
        height: 40,
        right: 1100,
        bottom: 540,
        x: 900,
        y: 500,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-screen-offset",
        onEvent: (e) => events.push(e),
        doc,
        // Window is offset from screen origin; chrome is 100px tall.
        // Expected: x = 150 + 1000 = 1150, y = 80 + 100 + 520 = 700.
        window: {
          screenX: 150,
          screenY: 80,
          outerHeight: 820,
          innerHeight: 720,
        },
      });
    } finally {
      restore();
    }

    const trustedClick = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "trusted_click",
    ) as { type: string; x: number; y: number } | undefined;
    expect(trustedClick).toBeDefined();
    expect(trustedClick!.x).toBe(1150);
    expect(trustedClick!.y).toBe(700);
  });

  test("trusted_click adds no chrome offset when outerHeight equals innerHeight", async () => {
    // Kiosk / fullscreen / JSDOM-style windows report `outerHeight ==
    // innerHeight` (no browser chrome). The computed screen coords must
    // equal the raw client coords (plus screenX/Y, which are 0 here) —
    // any positive chrome offset in this case is a bug.
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    const btn = doc.querySelector(
      selectors.PREJOIN_JOIN_NOW_BUTTON,
    ) as HTMLElement;
    btn.getBoundingClientRect = () =>
      ({
        left: 900,
        top: 500,
        width: 200,
        height: 40,
        right: 1100,
        bottom: 540,
        x: 900,
        y: 500,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-no-chrome",
        onEvent: (e) => events.push(e),
        doc,
        // No chrome, window at screen origin. Expected = raw rect center:
        // x = 1000, y = 520.
        window: {
          screenX: 0,
          screenY: 0,
          outerHeight: 720,
          innerHeight: 720,
        },
      });
    } finally {
      restore();
    }

    const trustedClick = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "trusted_click",
    ) as { type: string; x: number; y: number } | undefined;
    expect(trustedClick).toBeDefined();
    expect(trustedClick!.x).toBe(1000);
    expect(trustedClick!.y).toBe(520);
  });

  test("trusted_click documents the devtools-docked-bottom gap", async () => {
    // KNOWN GAP — not a fix. When devtools are docked to the *bottom* of
    // the window, Chromium reports `outerHeight > innerHeight` because of
    // the devtools panel below the viewport. The current math assumes the
    // entire `outerHeight - innerHeight` delta is TOP chrome and adds it
    // to screenY, which would push the click past the admission button
    // into (or below) the devtools surface. The production Xvfb container
    // never opens devtools, so this is documentation-only: if the
    // assumption ever breaks, this test pins the current (mis-)behavior
    // so the regression is explicit rather than silent. Do not "fix" this
    // in isolation — see the comment block in `join.ts`.
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    const btn = doc.querySelector(
      selectors.PREJOIN_JOIN_NOW_BUTTON,
    ) as HTMLElement;
    btn.getBoundingClientRect = () =>
      ({
        left: 900,
        top: 500,
        width: 200,
        height: 40,
        right: 1100,
        bottom: 540,
        x: 900,
        y: 500,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-devtools-bottom",
        onEvent: (e) => events.push(e),
        doc,
        // Simulate devtools docked to the bottom: outerHeight is inflated
        // by 300px that sits BELOW the viewport, not above it. The
        // current math treats it as TOP chrome — y becomes 500 + 300 +
        // 20 = 820 instead of the correct 520.
        window: {
          screenX: 0,
          screenY: 0,
          outerHeight: 1020,
          innerHeight: 720,
        },
      });
    } finally {
      restore();
    }

    const trustedClick = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "trusted_click",
    ) as { type: string; x: number; y: number } | undefined;
    expect(trustedClick).toBeDefined();
    // Pins the known-mismeasured behavior. If the math is ever updated
    // to distinguish top vs bottom chrome, this expectation must be
    // updated to 520 and the comment above deleted.
    expect(trustedClick!.x).toBe(1000);
    expect(trustedClick!.y).toBe(820);
  });

  test("falls back to Ask to join when Join now is absent", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Simulate a locked meeting: remove the Join now button so the fallback
    // branch fires.
    doc.querySelector(selectors.PREJOIN_JOIN_NOW_BUTTON)?.remove();
    const clicks = spyOnClick(doc, selectors.PREJOIN_ASK_TO_JOIN_BUTTON);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-2",
        onEvent: () => {},
        doc,
      });
    } finally {
      restore();
    }

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
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-3",
        onEvent: () => {},
        doc,
      });
    } finally {
      restore();
    }

    expect(modalClicks).toEqual([selectors.PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON]);
    expect(joinClicks).toEqual([selectors.PREJOIN_JOIN_NOW_BUTTON]);
  });

  test("skips the name fill when the input is not rendered (signed-in flow)", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Signed-in flow: no "Your name" input, but the join buttons are still
    // there.
    doc.querySelector(selectors.PREJOIN_NAME_INPUT)?.remove();
    const clicks = spyOnClick(doc, selectors.PREJOIN_JOIN_NOW_BUTTON);
    insertPostAdmissionToolbar(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-4",
        onEvent: () => {},
        doc,
      });
    } finally {
      restore();
    }

    // No name input means nothing to assert on `.value` — instead verify the
    // flow still clicked Join now, demonstrating the branch didn't fail.
    expect(clicks).toEqual([selectors.PREJOIN_JOIN_NOW_BUTTON]);
  });

  test("posts the consent message to the chat composer at step 6", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    const { input, sendButton } = insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    let sendClicks = 0;
    sendButton.addEventListener("click", () => {
      sendClicks += 1;
    });

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-consent",
        onEvent: (e) => events.push(e),
        doc,
      });
    } finally {
      restore();
    }

    // The consent text made it into the composer textarea.
    expect(input.value).toBe("Hi, Vellum is listening.");
    // The send button was clicked exactly once to submit the message.
    expect(sendClicks).toBe(1);

    // No error diagnostics on the happy path.
    const errorDiagnostics = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "diagnostic" &&
        (e as { level?: string }).level === "error",
    );
    expect(errorDiagnostics.length).toBe(0);
  });

  test("surfaces a diagnostic but does not fail the join when the consent post fails", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertPostAdmissionToolbar(doc);
    // Mount the message list (so ensurePanelOpen short-circuits) but
    // deliberately omit the chat composer so sendChat throws "chat input
    // not found". The bot is already admitted at this point, so the join
    // must still resolve successfully.
    const list = doc.createElement("div");
    list.setAttribute("role", "list");
    list.setAttribute("aria-label", "Chat messages");
    doc.body.appendChild(list);
    const restore = installGlobalDoc(doc);

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-consent-fail",
        onEvent: (e) => events.push(e),
        doc,
      });
    } finally {
      restore();
    }

    // Consent-post error surfaced as a diagnostic.
    const diag = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "diagnostic" &&
        (e as { level?: string }).level === "error" &&
        typeof (e as { message?: string }).message === "string" &&
        (e as { message: string }).message.startsWith("consent post failed:"),
    );
    expect(diag).toBeDefined();
  });

  test("emits a diagnostic and rejects when admission times out", async () => {
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    // Deliberately do NOT insert the post-admission toolbar — the
    // INGAME_READY_INDICATOR (mic toggle) never mounts, so step 5 should
    // reject. The beforeEach setTimeout patch collapses the 90s wait to a
    // single tick so the test runs quickly.

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

  test("resolves step 5 against the committed ingame fixture", async () => {
    // Load the prejoin fixture (for steps 1-4), then splice in the committed
    // ingame fixture's body contents so `INGAME_READY_INDICATOR` (the mic
    // toggle) is visible to step 5. This gives us an end-to-end assertion
    // that the selector chosen in `dom/selectors.ts` actually matches the
    // real captured post-admission markup — not just the synthesized toolbar
    // used by the other happy-path tests.
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    spliceIngameFixture(doc);
    insertChatSurface(doc);
    const restore = installGlobalDoc(doc);

    const events: unknown[] = [];
    try {
      await runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-ingame-fixture",
        onEvent: (e) => events.push(e),
        doc,
      });
    } finally {
      restore();
    }

    // Sanity-check: the mic toggle came in via the ingame fixture.
    expect(doc.querySelector(selectors.INGAME_READY_INDICATOR)).not.toBeNull();

    // And no error diagnostics fired — step 5 resolved cleanly.
    const errorDiagnostics = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "diagnostic" &&
        (e as { level?: string }).level === "error",
    );
    expect(errorDiagnostics.length).toBe(0);
  });

  test("regression: a lone Leave button is NOT accepted as the in-meeting signal", async () => {
    // This is the whole-point regression: before PR 4, step 5 waited on
    // `INGAME_LEAVE_BUTTON`, which Meet renders in BOTH the waiting-room and
    // in-meeting UIs — so `waitForSelector` resolved immediately after the
    // "Ask to join" click, BEFORE the host actually admitted the bot, and
    // step 6 (post consent in chat) fired in the waiting room where no chat
    // surface exists.
    //
    // We simulate the waiting-room surface by inserting ONLY the "Leave
    // call" button (no mic toggle) and assert the join flow now times out
    // at step 5 instead of racing ahead. The `beforeEach` setTimeout patch
    // collapses the 90s wait to a single tick so the test runs quickly.
    const { doc } = loadPrejoinDom();
    removeMediaModal(doc);
    insertLeaveButtonOnly(doc);

    const events: unknown[] = [];
    await expect(
      runJoinFlow({
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        displayName: "Vellum Bot",
        consentMessage: "Hi, Vellum is listening.",
        meetingId: "mtg-leave-button-alone",
        onEvent: (e) => events.push(e),
        doc,
      }),
    ).rejects.toThrow(/in-meeting UI did not appear/i);

    // Diagnostic was emitted before the throw.
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
