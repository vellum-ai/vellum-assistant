/**
 * DOM wait helpers for the content script.
 *
 * The meet-controller extension runs inside Meet's page world as a Manifest V3
 * content script — it does not have access to Playwright-style `waitForSelector`
 * APIs. These helpers replicate the small subset of that behavior the join /
 * chat flows need, implemented on top of `MutationObserver` so they work in
 * any browser context without extra dependencies.
 *
 * Design notes:
 *
 *   - Every wait checks the document synchronously once before attaching an
 *     observer; this keeps the happy path (the element is already in the DOM)
 *     cheap and avoids racing against the first mutation.
 *   - The observer is always disconnected before the returned promise settles,
 *     whether the wait succeeded, timed out, or was rejected by an internal
 *     failure. Leaking observers on a Meet page is expensive because the DOM
 *     mutates constantly.
 *   - Errors use a stable message shape (`"timeout waiting for " + selector`)
 *     so the caller can build descriptive diagnostics without having to match
 *     on regex.
 *   - A `document`-scoped argument is exposed so tests can substitute a JSDOM
 *     document; production callers use the real `document` default.
 *   - The optional `interactable` filter gates resolution on the element being
 *     user-interactable, not merely present. Meet keeps hidden template and
 *     transition nodes in the tree (e.g. during prejoin → in-meeting
 *     transitions); a raw `querySelector` can match one before it becomes
 *     clickable, which then makes the join flow click the wrong path and
 *     time out in admission. The filter rejects elements that are explicitly
 *     marked hidden (via `hidden` / `aria-hidden="true"` on self or ancestor,
 *     or inline `display: none` / `visibility: hidden` / `pointer-events:
 *     none`). When available it also defers to `Element.checkVisibility()`
 *     for the layout-aware cases (opacity, content-visibility, off-screen
 *     offsetParent) — jsdom has no layout engine, so we fall back to the
 *     attribute/style checks alone in tests.
 */

/**
 * Return `true` when `el` looks user-interactable, `false` when it's a hidden
 * template/transition node that happens to match a selector.
 *
 * Conservative: only filters out elements that are *demonstrably* hidden via
 * explicit attributes, inline styles, or the native visibility check. Elements
 * that merely lack positive evidence of being interactable (common in jsdom,
 * where there is no layout) pass through.
 */
function isInteractable(el: Element): boolean {
  const html = el as HTMLElement;

  // Ancestor-or-self check: `hidden` / `aria-hidden="true"` on any enclosing
  // node hides this one too. `closest` matches self, so a direct attribute
  // on `el` is also caught here.
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;

  const style = html.style;
  if (style) {
    if (style.display === "none") return false;
    if (style.visibility === "hidden") return false;
    if (style.pointerEvents === "none") return false;
  }

  // Chrome 105+ ships `Element.checkVisibility()`, which handles the
  // layout-dependent cases (detached subtree, `content-visibility: hidden`,
  // zero opacity) that our attribute sniffing cannot. Skip the call in
  // environments that lack it (e.g. jsdom).
  const check = (
    el as unknown as {
      checkVisibility?: (opts?: {
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (typeof check === "function") {
    try {
      if (!check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch {
      // Defensive: if `checkVisibility` throws on some quirky element, fall
      // through to accept the match — we've already applied the stricter
      // attribute filters above.
    }
  }

  return true;
}

export interface WaitOptions {
  /**
   * When `true`, reject selector matches whose element is demonstrably
   * hidden (see {@link isInteractable}). Default `false` preserves the
   * original "any matching node" semantics for callers that do not care
   * about interactability.
   */
  interactable?: boolean;
}

/**
 * Resolve with the first element matching `sel`. Rejects with
 * `Error("timeout waiting for " + sel)` if no match appears within `timeoutMs`.
 *
 * Implementation strategy:
 *   1. Check the document synchronously — if the element is already there,
 *      return it without touching MutationObserver.
 *   2. Otherwise, attach a MutationObserver scoped to `{ childList: true,
 *      subtree: true, attributes: true }` at the document root, and re-run
 *      `querySelector` on each mutation batch. Attributes are observed so
 *      waits that key on aria-label changes (Meet toggles these during state
 *      transitions) fire on the next batch rather than waiting for a child
 *      insertion that may never come.
 *   3. Disconnect the observer in every settle path (match, timeout).
 */
export function waitForSelector(
  sel: string,
  timeoutMs: number,
  doc: Document = document,
  opts: WaitOptions = {},
): Promise<Element> {
  const wantInteractable = opts.interactable === true;
  const accept = (el: Element | null): el is Element =>
    el !== null && (!wantInteractable || isInteractable(el));

  return new Promise<Element>((resolve, reject) => {
    // Synchronous check — if it's already there (and interactable, when
    // requested), return immediately. This short-circuits the happy path
    // without touching MutationObserver.
    const existing = doc.querySelector(sel);
    if (accept(existing)) {
      resolve(existing);
      return;
    }

    let settled = false;
    const observer = new MutationObserver(() => {
      if (settled) return;
      const match = doc.querySelector(sel);
      if (accept(match)) {
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(match);
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      reject(new Error("timeout waiting for " + sel));
    }, timeoutMs);

    observer.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

/**
 * Resolve with `{ selector, element }` for the first selector in `selectors`
 * whose element appears in the DOM. Rejects with
 * `Error("timeout waiting for any of " + selectors.join(", "))` if no match
 * appears within `timeoutMs`.
 *
 * Semantics match Playwright's `Promise.race` over individual `waitForSelector`
 * calls in the bot's original join flow — used to branch on whichever of the
 * prejoin surfaces (name input, Join now, Ask to join) Meet renders first.
 */
export function waitForAny(
  selectors: string[],
  timeoutMs: number,
  doc: Document = document,
  opts: WaitOptions = {},
): Promise<{ selector: string; element: Element }> {
  const wantInteractable = opts.interactable === true;
  const firstMatch = (): { selector: string; element: Element } | null => {
    for (const selector of selectors) {
      const el = doc.querySelector(selector);
      if (el && (!wantInteractable || isInteractable(el))) {
        return { selector, element: el };
      }
    }
    return null;
  };

  return new Promise<{ selector: string; element: Element }>(
    (resolve, reject) => {
      // Synchronous check — return the first selector whose element already
      // matches (and is interactable, when requested).
      const initial = firstMatch();
      if (initial) {
        resolve(initial);
        return;
      }

      let settled = false;
      const observer = new MutationObserver(() => {
        if (settled) return;
        const match = firstMatch();
        if (match) {
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(match);
        }
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        reject(new Error("timeout waiting for any of " + selectors.join(", ")));
      }, timeoutMs);

      observer.observe(doc, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    },
  );
}
