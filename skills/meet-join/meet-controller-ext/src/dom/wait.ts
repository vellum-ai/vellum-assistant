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
 */

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
): Promise<Element> {
  return new Promise<Element>((resolve, reject) => {
    // Synchronous check — if it's already there, return immediately. This
    // short-circuits the happy path without touching MutationObserver.
    const existing = doc.querySelector(sel);
    if (existing) {
      resolve(existing);
      return;
    }

    let settled = false;
    const observer = new MutationObserver(() => {
      if (settled) return;
      const match = doc.querySelector(sel);
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
): Promise<{ selector: string; element: Element }> {
  return new Promise<{ selector: string; element: Element }>(
    (resolve, reject) => {
      // Synchronous check — return the first selector that already matches.
      for (const selector of selectors) {
        const existing = doc.querySelector(selector);
        if (existing) {
          resolve({ selector, element: existing });
          return;
        }
      }

      let settled = false;
      const observer = new MutationObserver(() => {
        if (settled) return;
        for (const selector of selectors) {
          const match = doc.querySelector(selector);
          if (match) {
            settled = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve({ selector, element: match });
            return;
          }
        }
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        reject(
          new Error("timeout waiting for any of " + selectors.join(", ")),
        );
      }, timeoutMs);

      observer.observe(doc, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    },
  );
}
