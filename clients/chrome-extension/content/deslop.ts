/**
 * Deslop content script: inspect-element-style picker that rewrites the
 * clicked block's text via the connected assistant.
 *
 * Injected on demand by the service worker (`deslop-activate`), never
 * declared in the manifest. The script is bundled as a classic script
 * (no imports/exports) so `chrome.scripting.executeScript({ files })`
 * can run it directly. Re-injection while a picker session is already
 * active restarts the session instead of stacking listeners.
 *
 * Flow: hover highlights the element under the cursor; click sends its
 * text to the worker (`deslop-rewrite`), which asks the assistant for a
 * plain-language rewrite. While the request is in flight the block is
 * dimmed under a shimmering overlay with a spinner badge and the hint
 * pill switches to its active state; the response then replaces the
 * element's content and the element is marked with a faint tint plus a
 * wand badge that toggles between the rewrite and the original content,
 * which is kept as live DOM nodes so its markup returns intact.
 * Esc exits the picker. The picker stays active after a rewrite so
 * several blocks can be cleaned up in one session, and several rewrites
 * can be in flight at once.
 */

(() => {
  const SESSION_PROP = "__vellumDeslopSession";
  const STYLE_ID = "vellum-deslop-style";
  const REWRITTEN_ATTR = "data-vellum-desloped";
  const PENDING_CLASS = "vellum-deslop-pending";
  const PROGRESS_CLASS = "vellum-deslop-progress";
  const SPINNER_CLASS = "vellum-deslop-spinner";
  const BADGE_CLASS = "vellum-deslop-badge";
  const SHOWING_ORIGINAL_CLASS = "vellum-deslop-showing-original";
  const HINT_CLASS = "vellum-deslop-hint";
  const HINT_ACTIVE_CLASS = "vellum-deslop-hint-active";
  const HINT_IDLE_TEXT =
    "Deslop: click a block of text to rewrite it · Esc to exit";
  const HINT_ACTIVE_TEXT = "Rewriting with your assistant…";
  const MIN_TEXT_LENGTH = 8;
  const MAX_TEXT_LENGTH = 20000;
  const WAND_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 4V2M15 10V8M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  interface DeslopSession {
    stop(): void;
  }

  interface DeslopRewriteResponse {
    ok: boolean;
    rewritten?: string;
    error?: string;
  }

  const globalScope = window as unknown as Record<string, unknown>;

  // Restart cleanly if a previous session is still active (button
  // clicked twice, or re-activated after a rewrite).
  const existing = globalScope[SESSION_PROP] as DeslopSession | undefined;
  if (existing) {
    existing.stop();
  }

  ensureStyles();

  const highlight = document.createElement("div");
  highlight.className = "vellum-deslop-highlight";
  const hint = document.createElement("div");
  hint.className = HINT_CLASS;
  hint.textContent = HINT_IDLE_TEXT;
  document.documentElement.append(highlight, hint);

  let hovered: HTMLElement | null = null;
  let pendingCount = 0;

  function isPickable(el: Element | null): el is HTMLElement {
    if (!(el instanceof HTMLElement)) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (el === hint || el === highlight) return false;
    if (el.closest(`.${PENDING_CLASS}`)) return false;
    const text = el.innerText?.trim() ?? "";
    return text.length >= MIN_TEXT_LENGTH;
  }

  function positionHighlight(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    highlight.style.display = "block";
    highlight.style.top = `${rect.top}px`;
    highlight.style.left = `${rect.left}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  function clearHighlight(): void {
    hovered = null;
    highlight.style.display = "none";
  }

  function onMouseMove(event: MouseEvent): void {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!isPickable(el)) {
      clearHighlight();
      return;
    }
    hovered = el;
    positionHighlight(el);
  }

  function onScrollOrResize(): void {
    if (hovered) positionHighlight(hovered);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop();
    }
  }

  // The wand badge owns its own click (it toggles between the rewrite and
  // the original), so the picker lets badge events through untouched.
  function isBadgeEvent(event: MouseEvent): boolean {
    const target = event.target;
    return target instanceof Element && target.closest(`.${BADGE_CLASS}`) !== null;
  }

  function onClick(event: MouseEvent): void {
    if (isBadgeEvent(event)) return;
    const target = hovered;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void rewriteElement(target);
  }

  // Swallow the mousedown/mouseup pair too so pages with mousedown-driven
  // handlers (menus, editors) don't react to the pick.
  function swallow(event: MouseEvent): void {
    if (isBadgeEvent(event)) return;
    if (hovered) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function syncHint(): void {
    if (!hint.isConnected) return;
    const active = pendingCount > 0;
    hint.className = active ? `${HINT_CLASS} ${HINT_ACTIVE_CLASS}` : HINT_CLASS;
    hint.textContent = active ? HINT_ACTIVE_TEXT : HINT_IDLE_TEXT;
  }

  // Dims the block under a shimmering overlay with a spinner badge, and
  // returns the matching teardown so concurrent rewrites clean up on
  // their own element without touching each other.
  function beginPending(el: HTMLElement): () => void {
    el.classList.add(PENDING_CLASS);
    if (getComputedStyle(el).position === "static") {
      el.style.position = "relative";
    }
    const overlay = document.createElement("div");
    overlay.className = PROGRESS_CLASS;
    const spinner = document.createElement("div");
    spinner.className = SPINNER_CLASS;
    el.append(overlay, spinner);
    pendingCount += 1;
    syncHint();

    return () => {
      overlay.remove();
      spinner.remove();
      el.classList.remove(PENDING_CLASS);
      pendingCount = Math.max(0, pendingCount - 1);
      syncHint();
    };
  }

  async function rewriteElement(el: HTMLElement): Promise<void> {
    const text = el.innerText.trim();
    if (text.length === 0) return;

    clearHighlight();
    clearRewrittenState(el);
    const endPending = beginPending(el);

    const response = await new Promise<DeslopRewriteResponse | undefined>(
      (resolve) => {
        // sendMessage throws synchronously once the extension context is
        // invalidated (the extension was reloaded while this script stayed
        // on the page), so the throw is folded into the same failure path
        // as an absent response rather than escaping as a rejection.
        try {
          chrome.runtime.sendMessage(
            { type: "deslop-rewrite", text: text.slice(0, MAX_TEXT_LENGTH) },
            (raw: DeslopRewriteResponse | undefined) => {
              // Read lastError so Chrome doesn't log an unchecked error
              // when the worker died mid-request.
              void chrome.runtime.lastError;
              resolve(raw);
            },
          );
        } catch {
          resolve({
            ok: false,
            error:
              "The extension was reloaded. Reopen the popup and press Deslop again.",
          });
        }
      },
    );

    endPending();

    if (!response?.ok || typeof response.rewritten !== "string") {
      flashError(el, response?.error ?? "The assistant could not rewrite this text.");
      return;
    }

    markRewritten(el, response.rewritten.trim());
  }

  // Drops the badge and toggle state of an earlier rewrite so a block
  // picked a second time starts from a clean slate.
  function clearRewrittenState(el: HTMLElement): void {
    el.classList.remove(SHOWING_ORIGINAL_CLASS);
    for (const badge of Array.from(el.querySelectorAll(`.${BADGE_CLASS}`))) {
      badge.remove();
    }
  }

  function markRewritten(el: HTMLElement, rewritten: string): void {
    el.setAttribute(REWRITTEN_ATTR, "true");
    if (getComputedStyle(el).position === "static") {
      el.style.position = "relative";
    }

    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.innerHTML = WAND_SVG;

    // The original content is held as live nodes rather than as text, so
    // toggling back restores its exact markup: code chips, list items,
    // links, and syntax highlighting all survive the round trip. The
    // overlay and spinner are already gone by this point, so the captured
    // set is exactly what the block displayed before the rewrite.
    const originalNodes = Array.from(el.childNodes);

    let showingOriginal = false;

    // Emptying the element first detaches the original nodes into their
    // array, which keeps the innerText write on the rewrite path from
    // destroying them. The badge is re-attached on every swap.
    function render(): void {
      el.replaceChildren();
      if (showingOriginal) {
        el.append(...originalNodes);
      } else {
        el.innerText = rewritten;
      }
      el.classList.toggle(SHOWING_ORIGINAL_CLASS, showingOriginal);
      badge.title = showingOriginal
        ? "Showing the original text. Click to show the rewrite."
        : "Rewritten by your Vellum assistant. Click to show the original.";
      el.appendChild(badge);
    }

    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showingOriginal = !showingOriginal;
      render();
    });

    render();
  }

  function flashError(el: HTMLElement, message: string): void {
    const note = document.createElement("div");
    note.className = "vellum-deslop-error";
    note.textContent = `Deslop failed: ${message}`;
    document.documentElement.appendChild(note);
    el.classList.add("vellum-deslop-failed");
    setTimeout(() => {
      note.remove();
      el.classList.remove("vellum-deslop-failed");
    }, 4000);
  }

  function stop(): void {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize, true);
    highlight.remove();
    hint.remove();
    delete globalScope[SESSION_PROP];
  }

  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScrollOrResize, true);
  window.addEventListener("resize", onScrollOrResize, true);

  globalScope[SESSION_PROP] = { stop } satisfies DeslopSession;

  function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .vellum-deslop-highlight {
        position: fixed;
        display: none;
        pointer-events: none;
        z-index: 2147483646;
        background: rgba(99, 102, 241, 0.14);
        outline: 2px solid rgba(99, 102, 241, 0.85);
        outline-offset: -1px;
        border-radius: 3px;
        transition: top 40ms linear, left 40ms linear, width 40ms linear, height 40ms linear;
      }
      .${HINT_CLASS} {
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 14px;
        border-radius: 999px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        pointer-events: none;
      }
      .${HINT_ACTIVE_CLASS} {
        background: rgba(79, 70, 229, 0.95);
      }
      .${PENDING_CLASS} {
        outline: 2px solid rgba(99, 102, 241, 0.85);
        outline-offset: -1px;
        opacity: 0.55;
      }
      .${PROGRESS_CLASS} {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 2147483644;
        border-radius: 3px;
        background-color: rgba(99, 102, 241, 0.1);
        background-image: linear-gradient(
          110deg,
          rgba(99, 102, 241, 0) 20%,
          rgba(99, 102, 241, 0.28) 50%,
          rgba(99, 102, 241, 0) 80%
        );
        background-repeat: no-repeat;
        background-size: 200% 100%;
        animation: vellum-deslop-shimmer 1.1s linear infinite;
      }
      @keyframes vellum-deslop-shimmer {
        from { background-position: -100% 0; }
        to { background-position: 200% 0; }
      }
      .${SPINNER_CLASS} {
        position: absolute;
        top: 2px;
        right: 2px;
        box-sizing: border-box;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: rgba(99, 102, 241, 0.95);
        pointer-events: none;
        z-index: 2147483645;
      }
      .${SPINNER_CLASS}::after {
        content: "";
        position: absolute;
        inset: 4px;
        box-sizing: border-box;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.35);
        border-top-color: #ffffff;
        animation: vellum-deslop-spin 0.8s linear infinite;
      }
      @keyframes vellum-deslop-spin {
        to { transform: rotate(360deg); }
      }
      [${REWRITTEN_ATTR}] {
        background-color: rgba(99, 102, 241, 0.07);
        border-radius: 3px;
        transition: background-color 300ms ease;
      }
      [${REWRITTEN_ATTR}].${SHOWING_ORIGINAL_CLASS} {
        background-color: transparent;
      }
      .${BADGE_CLASS} {
        position: absolute;
        top: 2px;
        right: 2px;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 1px solid transparent;
        background: rgba(99, 102, 241, 0.9);
        color: #ffffff;
        cursor: pointer;
        pointer-events: auto;
        z-index: 2147483645;
      }
      .${SHOWING_ORIGINAL_CLASS} .${BADGE_CLASS} {
        background: transparent;
        border-color: rgba(107, 114, 128, 0.7);
        color: rgba(107, 114, 128, 0.95);
      }
      .${BADGE_CLASS} svg {
        width: 11px;
        height: 11px;
        display: block;
      }
      .vellum-deslop-failed {
        outline: 2px solid rgba(220, 38, 38, 0.7);
        outline-offset: -1px;
      }
      .vellum-deslop-error {
        position: fixed;
        bottom: 56px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(153, 27, 27, 0.95);
        color: #fef2f2;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 8px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        pointer-events: none;
        max-width: 70vw;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
