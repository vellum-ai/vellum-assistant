/**
 * Common CDP idioms that each browser tool would otherwise reimplement:
 * selector resolution, mouse/keyboard dispatch, screenshot capture,
 * navigation, polling waits, and small Runtime.evaluate wrappers.
 *
 * Every helper takes a {@link CdpClient} as its first argument, forwards
 * an optional {@link AbortSignal} verbatim to `CdpClient.send`, and
 * throws a {@link CdpError} on failure. The module is pure plumbing —
 * no I/O beyond the injected CdpClient — which keeps it trivial to
 * unit-test against a fake in-memory client.
 */

import { CdpError } from "./errors.js";
import type { CdpClient } from "./types.js";

// ── Selector / node resolution ────────────────────────────────────────

/**
 * Resolve a CSS selector to a CDP `backendNodeId`. Runs
 * `DOM.getDocument` → `DOM.querySelector` → `DOM.describeNode` and
 * throws {@link CdpError} with `code: "cdp_error"` if no element
 * matches (CDP signals this by returning `nodeId: 0`).
 */
export async function querySelectorBackendNodeId(
  cdp: CdpClient,
  selector: string,
  signal?: AbortSignal,
): Promise<number> {
  const { root } = await cdp.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    {},
    signal,
  );
  const { nodeId } = await cdp.send<{ nodeId: number }>(
    "DOM.querySelector",
    { nodeId: root.nodeId, selector },
    signal,
  );
  if (!nodeId) {
    throw new CdpError("cdp_error", `Element not found: ${selector}`, {
      cdpMethod: "DOM.querySelector",
      cdpParams: { selector },
    });
  }
  const { node } = await cdp.send<{ node: { backendNodeId: number } }>(
    "DOM.describeNode",
    { nodeId, depth: 0 },
    signal,
  );
  return node.backendNodeId;
}

/** Scroll the element identified by `backendNodeId` into view if needed. */
export async function scrollIntoViewIfNeeded(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, signal);
}

/**
 * Read the element's content-quad via `DOM.getBoxModel` and return the
 * midpoint in viewport coordinates. CDP returns `content` as a flat
 * 8-number array `[x1,y1, x2,y2, x3,y3, x4,y4]`.
 */
export async function getCenterPoint(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  const { model } = await cdp.send<{
    model: { content: number[] };
  }>("DOM.getBoxModel", { backendNodeId }, signal);
  const xs = [
    model.content[0]!,
    model.content[2]!,
    model.content[4]!,
    model.content[6]!,
  ];
  const ys = [
    model.content[1]!,
    model.content[3]!,
    model.content[5]!,
    model.content[7]!,
  ];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

/** Focus an element by `backendNodeId` via `DOM.focus`. */
export async function focusElement(
  cdp: CdpClient,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("DOM.focus", { backendNodeId }, signal);
}

// ── Mouse / keyboard / wheel dispatch ─────────────────────────────────

/**
 * Dispatch a full left-click (mouseMoved + mousePressed + mouseReleased)
 * at the given viewport point.
 */
export async function dispatchClickAt(
  cdp: CdpClient,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<void> {
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseMoved" },
    signal,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed" },
    signal,
  );
  await cdp.send(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased" },
    signal,
  );
}

/** Dispatch a single mouseMoved (hover) at the given viewport point. */
export async function dispatchHoverAt(
  cdp: CdpClient,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: point.x, y: point.y, button: "none" },
    signal,
  );
}

/**
 * Insert text at the currently focused element via `Input.insertText`.
 * Unlike synthesizing individual key events, this dispatches the right
 * `input`/`change` events that form controls expect.
 */
export async function dispatchInsertText(
  cdp: CdpClient,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send("Input.insertText", { text }, signal);
}

/**
 * Per-key descriptor used by {@link dispatchKeyPress}. Mirrors the
 * fields CDP's `Input.dispatchKeyEvent` accepts. `text` is set only
 * for printable keys (so we know to also dispatch a `char` event).
 */
interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

/**
 * Subset of the US keyboard layout used to populate
 * `Input.dispatchKeyEvent` params. Without these fields, sites that
 * read `event.keyCode` (e.g. `event.keyCode === 13` for Enter) or
 * `event.code` see zeros and the press is silently ignored.
 *
 * Single-character keys (a-z, A-Z, 0-9) are resolved dynamically by
 * {@link resolveKeyDescriptor} to keep the static map small.
 */
const KEY_DESCRIPTORS: Record<string, KeyDescriptor> = {
  Enter: {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: {
    key: "ArrowDown",
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  },
  ArrowLeft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
};

/**
 * Resolve a key name into a {@link KeyDescriptor}. Single-character
 * keys (a-z, A-Z, 0-9) are computed on demand: `code` is `KeyA`/
 * `Digit0`/etc., `windowsVirtualKeyCode` is the uppercase ASCII code,
 * and `text` is the literal character. Returns `null` for unknown
 * multi-character keys so callers can fall back to a minimal event.
 */
function resolveKeyDescriptor(key: string): KeyDescriptor | null {
  const fromMap = KEY_DESCRIPTORS[key];
  if (fromMap) return fromMap;
  if (key.length !== 1) return null;
  const charCode = key.charCodeAt(0);
  // a-z / A-Z
  if (
    (charCode >= 65 && charCode <= 90) ||
    (charCode >= 97 && charCode <= 122)
  ) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: key,
    };
  }
  // 0-9
  if (charCode >= 48 && charCode <= 57) {
    return {
      key,
      code: `Digit${key}`,
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  // Other printable ASCII (space, punctuation): still emit text + the
  // raw char code so sites that check `event.key` and `event.charCode`
  // see something sensible.
  if (charCode >= 32 && charCode <= 126) {
    return {
      key,
      code: "",
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  return null;
}

/**
 * Press a single key (keyDown + optional `char` + keyUp). Resolves
 * the key name to a {@link KeyDescriptor} so CDP receives the right
 * `code` / `windowsVirtualKeyCode` / `text` fields — required by
 * sites that check `event.keyCode` (e.g. Enter-to-submit) or
 * `event.code`. For printable keys we also dispatch a `char` event
 * between keyDown and keyUp so the character is actually inserted
 * into focused inputs.
 */
export async function dispatchKeyPress(
  cdp: CdpClient,
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  const desc = resolveKeyDescriptor(key);
  if (!desc) {
    // Unknown multi-character key (e.g. F-keys we have not mapped).
    // Fall back to the minimal payload so callers still see a
    // keyDown/keyUp pair, and warn so we can extend the map.

    console.warn(
      `dispatchKeyPress: no descriptor for key "${key}", sending minimal event`,
    );
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key }, signal);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, signal);
    return;
  }

  const baseParams: Record<string, unknown> = {
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
  };
  if (desc.text !== undefined) {
    baseParams.text = desc.text;
  }

  await cdp.send(
    "Input.dispatchKeyEvent",
    { ...baseParams, type: "keyDown" },
    signal,
  );
  if (desc.text !== undefined) {
    await cdp.send(
      "Input.dispatchKeyEvent",
      { ...baseParams, type: "char" },
      signal,
    );
  }
  await cdp.send(
    "Input.dispatchKeyEvent",
    { ...baseParams, type: "keyUp" },
    signal,
  );
}

/** Dispatch a wheel scroll delta at the given viewport point. */
export async function dispatchWheelScroll(
  cdp: CdpClient,
  point: { x: number; y: number },
  delta: { deltaX: number; deltaY: number },
  signal?: AbortSignal,
): Promise<void> {
  await cdp.send(
    "Input.dispatchMouseEvent",
    {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: delta.deltaX,
      deltaY: delta.deltaY,
    },
    signal,
  );
}

// ── Runtime.evaluate wrappers ─────────────────────────────────────────

/** Get the current page URL via `Runtime.evaluate("document.location.href")`. */
export async function getCurrentUrl(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<string> {
  const { result } = await cdp.send<{ result: { value: string } }>(
    "Runtime.evaluate",
    { expression: "document.location.href", returnByValue: true },
    signal,
  );
  return result.value;
}

/** Get the current page title via `Runtime.evaluate("document.title")`. */
export async function getPageTitle(
  cdp: CdpClient,
  signal?: AbortSignal,
): Promise<string> {
  const { result } = await cdp.send<{ result: { value: string } }>(
    "Runtime.evaluate",
    { expression: "document.title", returnByValue: true },
    signal,
  );
  return result.value ?? "";
}

/**
 * Evaluate a JS expression via `Runtime.evaluate` and return the
 * deserialized value. Throws {@link CdpError} with `code: "cdp_error"`
 * if the expression threw (surfaced via CDP's `exceptionDetails`).
 *
 * Defaults: `returnByValue: true`, `awaitPromise: true`, `userGesture: true`.
 */
export async function evaluateExpression<T = unknown>(
  cdp: CdpClient,
  expression: string,
  opts?: { awaitPromise?: boolean },
  signal?: AbortSignal,
): Promise<T> {
  const res = await cdp.send<{
    result: { value: T };
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string };
    };
  }>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: opts?.awaitPromise ?? true,
      userGesture: true,
    },
    signal,
  );
  if (res.exceptionDetails) {
    const msg =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      "Runtime.evaluate exception";
    throw new CdpError("cdp_error", msg, {
      cdpMethod: "Runtime.evaluate",
      cdpParams: { expression },
    });
  }
  return res.result.value;
}

// ── Screenshot ────────────────────────────────────────────────────────

/**
 * Capture a JPEG screenshot via `Page.captureScreenshot` and return the
 * decoded bytes as a Node `Buffer`. Defaults to quality 80. Pass
 * `fullPage: true` to capture beyond the viewport.
 */
export async function captureScreenshotJpeg(
  cdp: CdpClient,
  opts: { quality?: number; fullPage?: boolean } = {},
  signal?: AbortSignal,
): Promise<Buffer> {
  const { data } = await cdp.send<{ data: string }>(
    "Page.captureScreenshot",
    {
      format: "jpeg",
      quality: opts.quality ?? 80,
      captureBeyondViewport: opts.fullPage === true,
    },
    signal,
  );
  return Buffer.from(data, "base64");
}

// ── Navigation / waiting ──────────────────────────────────────────────

/**
 * Navigate to `url` and wait until `document.readyState` reaches
 * `interactive` or `complete`, or the timeout elapses.
 *
 * CDP's `Page.navigate` resolves as soon as the request is sent, not
 * when the page has loaded. Subscribing to lifecycle events would
 * require a long-lived event channel that the extension-backed
 * CdpClient cannot currently provide, so this helper polls
 * `document.readyState` via {@link evaluateExpression} — which works
 * uniformly across both Playwright-backed and extension-backed
 * clients.
 *
 * Returns `{ finalUrl, timedOut }`. `finalUrl` is read after the wait
 * completes and may differ from `url` if the page redirected.
 */
export async function navigateAndWait(
  cdp: CdpClient,
  url: string,
  opts: { timeoutMs?: number } = {},
  signal?: AbortSignal,
): Promise<{ finalUrl: string; timedOut: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // CDP's `Page.navigate` does NOT throw on transport-layer errors
  // (DNS failure, connection refused, etc.). Instead it resolves with
  // `{ frameId, errorText? }` and we have to surface the failure
  // ourselves. Otherwise we silently start polling readyState on the
  // OLD page (which is "complete") and report success with the stale
  // URL.
  const navResp = await cdp.send<{ frameId?: string; errorText?: string }>(
    "Page.navigate",
    { url },
    signal,
  );
  if (navResp?.errorText) {
    throw new CdpError("cdp_error", navResp.errorText, {
      cdpMethod: "Page.navigate",
      cdpParams: { url },
    });
  }
  const startedAt = Date.now();
  // Track exit reason explicitly so the post-loop classification does
  // not race against `Date.now()` after a successful break (the final
  // readyState read could otherwise push us across the timeout
  // boundary and falsely flip `timedOut` back to true).
  let completed = false;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "Navigation aborted");
    }
    const state = await evaluateExpression<string>(
      cdp,
      "document.readyState",
      {},
      signal,
    );
    if (state === "interactive" || state === "complete") {
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const timedOut = !completed;
  const finalUrl = await getCurrentUrl(cdp, signal);
  return { finalUrl, timedOut };
}

/**
 * Poll until a selector matches an element in the requested state,
 * then return its `backendNodeId`. Throws {@link CdpError} on timeout
 * or abort.
 *
 * `state` controls the readiness check:
 * - `"visible"` (default): the element must be in the DOM AND have a
 *   non-zero bounding box AND not be `display:none` /
 *   `visibility:hidden`. This matches Playwright's
 *   `page.waitForSelector` default and is the right semantics for
 *   click/hover targets that may be hydrated asynchronously.
 * - `"attached"`: the element only needs to exist in the DOM. Useful
 *   for `browser_wait_for` selector mode where the caller just wants
 *   to know "did this node appear at all" regardless of layout.
 */
export async function waitForSelector(
  cdp: CdpClient,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
  opts: { state?: "attached" | "visible" } = {},
): Promise<number> {
  const state = opts.state ?? "visible";
  const startedAt = Date.now();
  const escapedSel = JSON.stringify(selector);
  const expression =
    state === "visible"
      ? `(() => {
          const el = document.querySelector(${escapedSel});
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
        })()`
      : `document.querySelector(${escapedSel}) !== null`;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "waitForSelector aborted");
    }
    const ready = await evaluateExpression<boolean>(
      cdp,
      expression,
      {},
      signal,
    );
    if (ready) {
      return await querySelectorBackendNodeId(cdp, selector, signal);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError("cdp_error", `Timed out waiting for ${selector}`);
}

/**
 * Poll `document.body.innerText` for a substring. Throws
 * {@link CdpError} on timeout or abort.
 */
export async function waitForText(
  cdp: CdpClient,
  text: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const escaped = JSON.stringify(text);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw new CdpError("aborted", "waitForText aborted");
    }
    const found = await evaluateExpression<boolean>(
      cdp,
      `(document.body?.innerText ?? "").includes(${escaped})`,
      {},
      signal,
    );
    if (found) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new CdpError("cdp_error", `Timed out waiting for text: ${text}`);
}
