/**
 * Deslop content script: an inspect-element-style rewrite picker plus a
 * highlight-to-ask assistant surface, both driven by the connected
 * assistant.
 *
 * Injected on demand by the service worker (`deslop-activate`), never
 * declared in the manifest. The script is bundled as a classic script
 * (no imports/exports) so `chrome.scripting.executeScript({ files })`
 * can run it directly.
 *
 * The script installs two layers:
 *
 * 1. A persistent page layer (`window.__vellumDeslopPage`), installed once
 *    per page and never reset by re-injection. It owns the conversation
 *    transcript, the floating selection menu, and the chat panel, so a
 *    question asked after a rewrite still sees that rewrite.
 * 2. A picker session (`window.__vellumDeslopSession`), restarted by every
 *    re-injection and torn down by Esc. Hover highlights the block under
 *    the cursor; click sends its text to the worker (`deslop-rewrite`),
 *    which asks the assistant for a plain-language rewrite. While the
 *    request is in flight the block is dimmed under a shimmering overlay
 *    with a spinner badge and the hint pill switches to its active state;
 *    the response then replaces the element's content and the element is
 *    marked with a faint tint plus a wand badge that toggles between the
 *    rewrite and the original content, which is kept as live DOM nodes so
 *    its markup returns intact. The picker stays active after a rewrite so
 *    several blocks can be cleaned up in one session, and several rewrites
 *    can be in flight at once.
 *
 * With no picker session running, selecting text on the page raises a
 * floating menu above the selection: `v` opens voice (not built yet) and
 * `c` opens the chat panel, which sends the highlighted text plus the
 * transcript to the worker (`deslop-chat`).
 */

(() => {
  const PAGE_PROP = "__vellumDeslopPage";
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
  const MENU_CLASS = "vellum-deslop-menu";
  const MENU_BUTTON_CLASS = "vellum-deslop-menu-button";
  const MENU_DIVIDER_CLASS = "vellum-deslop-menu-divider";
  const MENU_NOTICE_CLASS = "vellum-deslop-menu-notice";
  const PANEL_CLASS = "vellum-deslop-panel";
  const PANEL_HEADER_CLASS = "vellum-deslop-panel-header";
  const PANEL_TITLE_CLASS = "vellum-deslop-panel-title";
  const PANEL_CLOSE_CLASS = "vellum-deslop-panel-close";
  const CONTEXT_CLASS = "vellum-deslop-context";
  const MESSAGES_CLASS = "vellum-deslop-messages";
  const MESSAGE_CLASS = "vellum-deslop-message";
  const MESSAGE_USER_CLASS = "vellum-deslop-message-user";
  const MESSAGE_ASSISTANT_CLASS = "vellum-deslop-message-assistant";
  const MESSAGE_ERROR_CLASS = "vellum-deslop-message-error";
  const THINKING_CLASS = "vellum-deslop-thinking";
  const THINKING_DOT_CLASS = "vellum-deslop-thinking-dot";
  const COMPOSER_CLASS = "vellum-deslop-composer";
  const INPUT_CLASS = "vellum-deslop-input";
  const SEND_CLASS = "vellum-deslop-send";

  const HINT_IDLE_TEXT =
    "Deslop: click a block of text to rewrite it · Esc to exit";
  const HINT_ACTIVE_TEXT = "Rewriting with your assistant…";
  const MIN_TEXT_LENGTH = 8;
  const MAX_TEXT_LENGTH = 20000;
  const MIN_SELECTION_LENGTH = 3;
  const SELECTION_DEBOUNCE_MS = 150;
  const VOICE_NOTICE_MS = 2000;
  const VIEWPORT_MARGIN = 8;
  const ANCHOR_GAP = 8;
  const CONTEXT_PREVIEW_LENGTH = 120;
  const RELOADED_MESSAGE =
    "The extension was reloaded. Reopen the popup and press Deslop again.";
  const WAND_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 4V2M15 10V8M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  interface DeslopSession {
    stop(): void;
  }

  /** The page-lifetime surface the picker session talks to. */
  interface DeslopPage {
    recordRewrite(promptUsed: unknown, rewritten: string): void;
  }

  interface TranscriptTurn {
    role: "user" | "assistant";
    content: string;
  }

  interface DeslopRewriteResponse {
    ok: boolean;
    rewritten?: string;
    promptUsed?: string;
    error?: string;
  }

  interface DeslopChatResponse {
    ok: boolean;
    reply?: string;
    userTurn?: string;
    error?: string;
  }

  /** A selection or panel anchor in page coordinates, so scrolling keeps it valid. */
  interface Anchor {
    top: number;
    left: number;
    width: number;
    height: number;
  }

  const globalScope = window as unknown as Record<string, unknown>;

  ensureStyles();

  // The page layer outlives every picker session, so a re-injection reuses
  // the installed one and keeps the transcript intact.
  const page =
    (globalScope[PAGE_PROP] as DeslopPage | undefined) ?? installPageLayer();

  // Restart cleanly if a previous session is still active (button
  // clicked twice, or re-activated after a rewrite).
  const existing = globalScope[SESSION_PROP] as DeslopSession | undefined;
  if (existing) {
    existing.stop();
  }

  const highlight = document.createElement("div");
  highlight.className = "vellum-deslop-highlight";
  const hint = document.createElement("div");
  hint.className = HINT_CLASS;
  hint.textContent = HINT_IDLE_TEXT;
  document.documentElement.append(highlight, hint);

  let hovered: HTMLElement | null = null;
  let pendingCount = 0;

  function isPickable(el: Element | null): el is HTMLElement {
    if (!(el instanceof HTMLElement)) {
      return false;
    }
    if (el === document.documentElement || el === document.body) {
      return false;
    }
    if (el === hint || el === highlight) {
      return false;
    }
    if (el.closest(`.${PENDING_CLASS}`)) {
      return false;
    }
    if (isOwnUi(el)) {
      return false;
    }
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
    if (hovered) {
      positionHighlight(hovered);
    }
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
    if (isBadgeEvent(event)) {
      return;
    }
    const target = hovered;
    if (!target) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void rewriteElement(target);
  }

  // Swallow the mousedown/mouseup pair too so pages with mousedown-driven
  // handlers (menus, editors) don't react to the pick.
  function swallow(event: MouseEvent): void {
    if (isBadgeEvent(event)) {
      return;
    }
    if (hovered) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function syncHint(): void {
    if (!hint.isConnected) {
      return;
    }
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
    if (text.length === 0) {
      return;
    }

    clearHighlight();
    clearRewrittenState(el);
    const endPending = beginPending(el);

    const response = await sendToWorker<DeslopRewriteResponse>({
      type: "deslop-rewrite",
      text: text.slice(0, MAX_TEXT_LENGTH),
    });

    endPending();

    if (!response?.ok || typeof response.rewritten !== "string") {
      flashError(el, response?.error ?? "The assistant could not rewrite this text.");
      return;
    }

    const rewritten = response.rewritten.trim();
    page.recordRewrite(response.promptUsed, rewritten);
    markRewritten(el, rewritten);
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

  /** True while a picker session owns the page's mouse and Esc handling. */
  function isPickerActive(): boolean {
    return globalScope[SESSION_PROP] !== undefined;
  }

  function isOwnUi(node: Node | null | undefined): boolean {
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    if (!el) {
      return false;
    }
    return el.closest(`.${MENU_CLASS}, .${PANEL_CLASS}`) !== null;
  }

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target.isContentEditable) {
      return true;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
  }

  function anchorFromRect(rect: DOMRect): Anchor {
    return {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    };
  }

  // Places a fixed-position element above its anchor, centered and clamped
  // to the viewport, dropping below when there is no room above.
  function placeFloater(el: HTMLElement, anchor: Anchor): void {
    const top = anchor.top - window.scrollY;
    const left = anchor.left - window.scrollX;
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const x = Math.min(
      Math.max(left + anchor.width / 2 - width / 2, VIEWPORT_MARGIN),
      maxX,
    );

    const above = top - height - ANCHOR_GAP;
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    const y = Math.min(
      Math.max(above >= VIEWPORT_MARGIN ? above : top + anchor.height + ANCHOR_GAP, VIEWPORT_MARGIN),
      maxY,
    );

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  // Folds a synchronous throw (the extension was reloaded while this script
  // stayed on the page) and an absent response into one failure path.
  function sendToWorker<T extends { ok: boolean; error?: string }>(
    message: Record<string, unknown>,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (raw: T | undefined) => {
          // Read lastError so Chrome doesn't log an unchecked error when
          // the worker died mid-request.
          void chrome.runtime.lastError;
          resolve(raw);
        });
      } catch {
        resolve({ ok: false, error: RELOADED_MESSAGE } as T);
      }
    });
  }

  /**
   * Installs the page-lifetime layer: the transcript shared by rewrites and
   * chat, the floating selection menu, and the chat panel. Runs once per
   * page; later injections reuse the returned object.
   */
  function installPageLayer(): DeslopPage {
    const transcript: TranscriptTurn[] = [];

    const menu = document.createElement("div");
    menu.className = MENU_CLASS;
    const voiceButton = document.createElement("button");
    voiceButton.type = "button";
    voiceButton.className = MENU_BUTTON_CLASS;
    voiceButton.textContent = "Voice (v)";
    const divider = document.createElement("span");
    divider.className = MENU_DIVIDER_CLASS;
    const chatButton = document.createElement("button");
    chatButton.type = "button";
    chatButton.className = MENU_BUTTON_CLASS;
    chatButton.textContent = "Chat (c)";
    const notice = document.createElement("span");
    notice.className = MENU_NOTICE_CLASS;
    notice.textContent = "Voice: coming soon";
    menu.append(voiceButton, divider, chatButton);

    const panel = document.createElement("div");
    panel.className = PANEL_CLASS;
    const panelHeader = document.createElement("div");
    panelHeader.className = PANEL_HEADER_CLASS;
    const panelTitle = document.createElement("span");
    panelTitle.className = PANEL_TITLE_CLASS;
    panelTitle.textContent = "Ask your assistant";
    const panelClose = document.createElement("button");
    panelClose.type = "button";
    panelClose.className = PANEL_CLOSE_CLASS;
    panelClose.textContent = "×";
    panelClose.title = "Close";
    panelHeader.append(panelTitle, panelClose);
    const contextChip = document.createElement("div");
    contextChip.className = CONTEXT_CLASS;
    const messages = document.createElement("div");
    messages.className = MESSAGES_CLASS;
    const composer = document.createElement("div");
    composer.className = COMPOSER_CLASS;
    const input = document.createElement("input");
    input.type = "text";
    input.className = INPUT_CLASS;
    input.placeholder = "Ask about the highlighted text";
    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = SEND_CLASS;
    sendButton.textContent = "Send";
    composer.append(input, sendButton);
    panel.append(panelHeader, contextChip, messages, composer);

    document.documentElement.append(menu, panel);

    let menuVisible = false;
    let panelOpen = false;
    let chatBusy = false;
    let selectionText = "";
    let selectionAnchor: Anchor | null = null;
    let panelAnchor: Anchor | null = null;
    // The highlighted text rides along with the next message only: once it
    // is sent, the transcript already carries that context.
    let pendingHighlight = "";
    let selectionTimer: number | undefined;
    let noticeTimer: number | undefined;

    function showMenu(anchor: Anchor): void {
      selectionAnchor = anchor;
      setMenuActions();
      menu.style.display = "flex";
      menuVisible = true;
      placeFloater(menu, anchor);
    }

    function hideMenu(): void {
      if (noticeTimer !== undefined) {
        window.clearTimeout(noticeTimer);
        noticeTimer = undefined;
      }
      setMenuActions();
      menu.style.display = "none";
      menuVisible = false;
      selectionAnchor = null;
      selectionText = "";
    }

    function setMenuActions(): void {
      menu.replaceChildren(voiceButton, divider, chatButton);
    }

    function showVoiceNotice(): void {
      if (noticeTimer !== undefined) {
        window.clearTimeout(noticeTimer);
      }
      menu.replaceChildren(notice);
      if (selectionAnchor) {
        placeFloater(menu, selectionAnchor);
      }
      noticeTimer = window.setTimeout(() => {
        noticeTimer = undefined;
        hideMenu();
      }, VOICE_NOTICE_MS);
    }

    function evaluateSelection(): void {
      // The voice notice holds the pill for its two seconds: the mouseup
      // that opened it must not swap the buttons back in underneath.
      if (noticeTimer !== undefined) {
        return;
      }
      // The picker owns the pointer while it runs, so the menu stays out
      // of its way.
      if (isPickerActive()) {
        hideMenu();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        hideMenu();
        return;
      }
      const text = selection.toString().trim();
      if (text.length < MIN_SELECTION_LENGTH) {
        hideMenu();
        return;
      }
      if (isOwnUi(selection.anchorNode)) {
        hideMenu();
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hideMenu();
        return;
      }
      selectionText = text;
      showMenu(anchorFromRect(rect));
    }

    function scheduleEvaluate(): void {
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(evaluateSelection, SELECTION_DEBOUNCE_MS);
    }

    function openChatFromSelection(): void {
      // The captured text can go stale if the menu was hidden and re-shown
      // through an unusual event ordering, so the live selection wins when
      // the capture is empty.
      const text =
        selectionText || (window.getSelection()?.toString().trim() ?? "");
      const anchor = selectionAnchor;
      hideMenu();
      window.getSelection()?.removeAllRanges();
      openChat(text, anchor);
    }

    function openChat(highlighted: string, anchor: Anchor | null): void {
      pendingHighlight = highlighted;
      contextChip.textContent = truncate(highlighted, CONTEXT_PREVIEW_LENGTH);
      contextChip.style.display = highlighted ? "block" : "none";
      panel.style.display = "flex";
      panelOpen = true;
      if (anchor) {
        panelAnchor = anchor;
      }
      if (panelAnchor) {
        placeFloater(panel, panelAnchor);
      }
      input.focus();
      scrollMessagesToBottom();
    }

    function closeChat(): void {
      panel.style.display = "none";
      panelOpen = false;
    }

    function scrollMessagesToBottom(): void {
      messages.scrollTop = messages.scrollHeight;
    }

    function appendBubble(kind: "user" | "assistant" | "error", text: string): HTMLElement {
      const bubble = document.createElement("div");
      const modifier =
        kind === "user"
          ? MESSAGE_USER_CLASS
          : kind === "assistant"
            ? MESSAGE_ASSISTANT_CLASS
            : MESSAGE_ERROR_CLASS;
      bubble.className = `${MESSAGE_CLASS} ${modifier}`;
      bubble.textContent = text;
      messages.appendChild(bubble);
      scrollMessagesToBottom();
      return bubble;
    }

    function appendThinking(): HTMLElement {
      const thinking = document.createElement("div");
      thinking.className = `${MESSAGE_CLASS} ${MESSAGE_ASSISTANT_CLASS} ${THINKING_CLASS}`;
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("span");
        dot.className = THINKING_DOT_CLASS;
        thinking.appendChild(dot);
      }
      messages.appendChild(thinking);
      scrollMessagesToBottom();
      return thinking;
    }

    function setChatBusy(busy: boolean): void {
      chatBusy = busy;
      input.disabled = busy;
      sendButton.disabled = busy;
    }

    async function sendChatMessage(): Promise<void> {
      if (chatBusy) {
        return;
      }
      const message = input.value.trim();
      if (message.length === 0) {
        return;
      }
      input.value = "";
      appendBubble("user", message);
      const highlighted = pendingHighlight;
      pendingHighlight = "";
      setChatBusy(true);
      const thinking = appendThinking();

      const response = await sendToWorker<DeslopChatResponse>({
        type: "deslop-chat",
        highlighted,
        message,
        transcript: transcript.map((turn) => ({
          role: turn.role,
          content: turn.content,
        })),
      });

      thinking.remove();
      setChatBusy(false);
      if (panelOpen) {
        input.focus();
      }

      if (!response?.ok || typeof response.reply !== "string") {
        // The highlight goes back on the next attempt so a retry keeps the
        // context the failed turn never delivered, unless a fresh highlight
        // arrived while the request was in flight.
        if (pendingHighlight.length === 0) {
          pendingHighlight = highlighted;
        }
        appendBubble(
          "error",
          response?.error ?? "The assistant could not answer that.",
        );
        return;
      }

      const userTurn =
        typeof response.userTurn === "string" && response.userTurn.length > 0
          ? response.userTurn
          : message;
      transcript.push(
        { role: "user", content: userTurn },
        { role: "assistant", content: response.reply },
      );
      appendBubble("assistant", response.reply);
    }

    function onSelectionChange(): void {
      scheduleEvaluate();
    }

    function onDocumentMouseDown(event: MouseEvent): void {
      if (!menuVisible) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && menu.contains(target)) {
        return;
      }
      hideMenu();
    }

    function onPageKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (panelOpen) {
          event.preventDefault();
          event.stopPropagation();
          closeChat();
          return;
        }
        if (menuVisible) {
          event.preventDefault();
          event.stopPropagation();
          hideMenu();
        }
        return;
      }
      if (!menuVisible || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "v" && key !== "c") {
        return;
      }
      // The page never sees the shortcut, so single-key hotkeys on the
      // host page stay dormant while the menu is up.
      event.preventDefault();
      event.stopPropagation();
      if (key === "v") {
        showVoiceNotice();
      } else {
        openChatFromSelection();
      }
    }

    function onPageScrollOrResize(): void {
      if (menuVisible && selectionAnchor) {
        placeFloater(menu, selectionAnchor);
      }
      if (panelOpen && panelAnchor) {
        placeFloater(panel, panelAnchor);
      }
    }

    // Keeping the selection alive through the click is what lets the menu
    // hand the highlighted text to the chat panel.
    menu.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    voiceButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showVoiceNotice();
    });
    chatButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openChatFromSelection();
    });
    panelClose.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeChat();
    });
    sendButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void sendChatMessage();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void sendChatMessage();
      }
    });
    // Typing in the panel stays inside the panel: host-page hotkeys never
    // see the keystrokes.
    panel.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mouseup", scheduleEvaluate, true);
    document.addEventListener("mousedown", onDocumentMouseDown, true);
    document.addEventListener("keydown", onPageKeyDown, true);
    window.addEventListener("scroll", onPageScrollOrResize, true);
    window.addEventListener("resize", onPageScrollOrResize, true);

    const api: DeslopPage = {
      recordRewrite(promptUsed: unknown, rewritten: string): void {
        // Older workers answer without the prompt they used. Recording the
        // rewrite alone would leave a dangling assistant turn, so the pair
        // is skipped instead.
        if (typeof promptUsed !== "string" || promptUsed.length === 0) {
          return;
        }
        if (rewritten.length === 0) {
          return;
        }
        transcript.push(
          { role: "user", content: promptUsed },
          { role: "assistant", content: rewritten },
        );
      },
    };

    globalScope[PAGE_PROP] = api;
    return api;
  }

  function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
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
      .${MENU_CLASS} {
        position: fixed;
        top: 0;
        left: 0;
        display: none;
        align-items: center;
        gap: 2px;
        z-index: 2147483647;
        box-sizing: border-box;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 4px 6px;
        border-radius: 999px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      }
      .${MENU_CLASS} .${MENU_BUTTON_CLASS} {
        box-sizing: border-box;
        margin: 0;
        border: 0;
        background: transparent;
        color: #f9fafb;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
        white-space: nowrap;
      }
      .${MENU_CLASS} .${MENU_BUTTON_CLASS}:hover {
        background: rgba(255, 255, 255, 0.16);
      }
      .${MENU_CLASS} .${MENU_DIVIDER_CLASS} {
        width: 1px;
        height: 14px;
        background: rgba(255, 255, 255, 0.22);
      }
      .${MENU_CLASS} .${MENU_NOTICE_CLASS} {
        color: #e5e7eb;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 5px 10px;
        white-space: nowrap;
      }
      .${PANEL_CLASS} {
        position: fixed;
        top: 0;
        left: 0;
        display: none;
        flex-direction: column;
        box-sizing: border-box;
        width: 340px;
        max-height: 50vh;
        z-index: 2147483647;
        background: rgba(17, 24, 39, 0.97);
        color: #f9fafb;
        font: 400 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        border: 1px solid rgba(99, 102, 241, 0.35);
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        overflow: hidden;
      }
      .${PANEL_CLASS} .${PANEL_HEADER_CLASS} {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px 6px 12px;
      }
      .${PANEL_CLASS} .${PANEL_TITLE_CLASS} {
        font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #c7d2fe;
        letter-spacing: 0.02em;
      }
      .${PANEL_CLASS} .${PANEL_CLOSE_CLASS} {
        box-sizing: border-box;
        margin: 0;
        border: 0;
        background: transparent;
        color: #9ca3af;
        font: 500 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .${PANEL_CLASS} .${PANEL_CLOSE_CLASS}:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #f9fafb;
      }
      .${PANEL_CLASS} .${CONTEXT_CLASS} {
        margin: 0 12px 8px 12px;
        padding: 6px 10px;
        border-left: 2px solid rgba(99, 102, 241, 0.85);
        border-radius: 0 6px 6px 0;
        background: rgba(99, 102, 241, 0.1);
        color: #9ca3af;
        font: 400 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        word-break: break-word;
      }
      .${PANEL_CLASS} .${MESSAGES_CLASS} {
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 0 12px;
      }
      .${PANEL_CLASS} .${MESSAGE_CLASS} {
        box-sizing: border-box;
        max-width: 85%;
        padding: 7px 10px;
        border-radius: 10px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .${PANEL_CLASS} .${MESSAGE_USER_CLASS} {
        align-self: flex-end;
        background: rgba(99, 102, 241, 0.28);
        color: #eef2ff;
      }
      .${PANEL_CLASS} .${MESSAGE_ASSISTANT_CLASS} {
        align-self: flex-start;
        background: rgba(255, 255, 255, 0.08);
        color: #e5e7eb;
      }
      .${PANEL_CLASS} .${MESSAGE_ERROR_CLASS} {
        align-self: flex-start;
        background: rgba(153, 27, 27, 0.35);
        color: #fecaca;
      }
      .${PANEL_CLASS} .${THINKING_CLASS} {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .${PANEL_CLASS} .${THINKING_DOT_CLASS} {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: rgba(199, 210, 254, 0.9);
        animation: vellum-deslop-pulse 1.1s ease-in-out infinite;
      }
      .${PANEL_CLASS} .${THINKING_DOT_CLASS}:nth-child(2) {
        animation-delay: 0.15s;
      }
      .${PANEL_CLASS} .${THINKING_DOT_CLASS}:nth-child(3) {
        animation-delay: 0.3s;
      }
      @keyframes vellum-deslop-pulse {
        0%, 100% { opacity: 0.3; }
        50% { opacity: 1; }
      }
      .${PANEL_CLASS} .${COMPOSER_CLASS} {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 12px 12px 12px;
      }
      .${PANEL_CLASS} .${INPUT_CLASS} {
        box-sizing: border-box;
        flex: 1 1 auto;
        min-width: 0;
        margin: 0;
        padding: 7px 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.06);
        color: #f9fafb;
        font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        outline: none;
      }
      .${PANEL_CLASS} .${INPUT_CLASS}:focus {
        border-color: rgba(99, 102, 241, 0.85);
      }
      .${PANEL_CLASS} .${INPUT_CLASS}::placeholder {
        color: #6b7280;
      }
      .${PANEL_CLASS} .${SEND_CLASS} {
        box-sizing: border-box;
        margin: 0;
        border: 0;
        padding: 7px 12px;
        border-radius: 8px;
        background: rgba(99, 102, 241, 0.9);
        color: #ffffff;
        font: 600 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }
      .${PANEL_CLASS} .${SEND_CLASS}:hover {
        background: rgba(79, 70, 229, 0.95);
      }
      .${PANEL_CLASS} .${INPUT_CLASS}:disabled,
      .${PANEL_CLASS} .${SEND_CLASS}:disabled {
        opacity: 0.6;
        cursor: default;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
