/**
 * Centralized Google Meet DOM selectors.
 *
 * This module is the single source of truth for every CSS/attribute selector
 * the meet-controller extension uses to interact with Google Meet's web UI.
 * Consolidating them here means that when Meet's DOM drifts (which happens
 * frequently, often without warning) we only need to patch this one file and
 * refresh the HTML fixtures under `__tests__/fixtures/`.
 *
 * ## Consumers
 *
 * The selectors are consumed by the extension's content script (`src/content.ts`
 * and the `src/features/*` modules), which runs in Meet's page world and reads
 * the live DOM directly via `document.querySelector*`. This replaces the
 * previous Playwright-driven browser-side helpers that lived in the meet-bot
 * package — those helpers and their selectors have been retired in favor of a
 * Manifest V3 content script that operates on the same page in-process.
 *
 * ## Conventions
 *
 * - Prefer stable attributes (ARIA, role, data-*) over class names or positional
 *   CSS selectors. Class names in Meet are frequently minified and change across
 *   releases; aria-labels and roles are comparatively stable because they are
 *   part of Google's accessibility contract.
 * - Where a stable attribute is not available, fall back to a descriptive
 *   selector and tag the constant with `// TODO(meet-dom)`. These are the
 *   candidates most likely to break on the next Meet refresh and should be
 *   re-verified each time fixtures are recaptured.
 * - Every selector MUST be exercised by a fixture in `__tests__/selectors.test.ts`.
 *   If a new selector is added without a matching fixture assertion, the test
 *   suite will fail.
 *
 * ## Downstream consumers (inside this package)
 *
 * - `src/features/join.ts` — prejoin surface selectors
 * - `src/features/participants.ts` — participant panel selectors
 * - `src/features/speaker.ts` — active-speaker indicator
 * - `src/features/chat.ts` — chat panel selectors
 *
 * See `skills/meet-join/bot/README.md` § "Refreshing Meet DOM fixtures" for
 * the manual refresh process. (That documentation will relocate alongside the
 * extension when the bot's README is rewritten later in the migration.)
 */

/**
 * ISO-date string marking when the committed fixtures were captured.
 *
 * When a human developer refreshes the fixture HTML files from a live Meet
 * session, they should update this value to match the day of capture. That
 * lets us trace any fixture vs. production mismatch to a concrete date and
 * decide whether to recapture.
 */
export const GOOGLE_MEET_SELECTOR_VERSION = "2026-04-19";

/**
 * Prejoin-surface selectors — the "Ready to join?" screen shown before the bot
 * enters the meeting room.
 */
export const prejoinSelectors = {
  /**
   * Text input where the joining participant types their display name. Meet
   * exposes this with `aria-label="Your name"` when the user is not signed in.
   * Signed-in flows skip this input (the name comes from the Google account),
   * so callers must treat it as optional.
   */
  NAME_INPUT: 'input[aria-label="Your name"]',

  /**
   * "Use microphone and camera" button in the media-permission modal Meet
   * overlays on the prejoin screen for anonymous joiners. The modal blocks the
   * underlying prejoin UI until it is dismissed, so the bot must click this
   * (or the "Continue without microphone and camera" link) before any other
   * prejoin selector becomes interactable. Chromium's
   * `--use-fake-ui-for-media-stream` only auto-accepts the *browser's* native
   * permission prompt — this dialog is rendered by Meet itself and must be
   * clicked through explicitly.
   */
  MEDIA_PROMPT_ACCEPT_BUTTON: 'button[aria-label="Use microphone and camera"]',

  /**
   * "Ask to join" button shown when the meeting is locked and the bot needs
   * the host to admit it. Matches by aria-label prefix because Meet decorates
   * the label with context — e.g. `aria-label="Ask to join without camera"`
   * when the bot's camera is unavailable. The `^=` prefix match covers both
   * the bare and decorated forms.
   */
  // TODO(meet-dom): aria-label is localized. Future versions may need to
  // match multiple locales or fall back to role=button + text content.
  ASK_TO_JOIN_BUTTON: 'button[aria-label^="Ask to join"]',

  /**
   * "Join now" button shown when the meeting is open or the bot is already
   * trusted (e.g. same-domain policy). Distinct from Ask-to-join so the caller
   * can branch on which flow Meet presented. Prefix match covers the bare
   * label plus Meet's "Join now without camera" etc. variants.
   */
  JOIN_NOW_BUTTON: 'button[aria-label^="Join now"]',
} as const;

/**
 * In-meeting chat panel selectors. The chat panel is collapsed by default and
 * must be opened by clicking the chat toggle button before the input/send
 * controls become visible.
 */
export const chatSelectors = {
  /** Toggle button in the meeting toolbar that opens the chat side panel. */
  PANEL_BUTTON: 'button[aria-label="Chat with everyone"]',

  /**
   * Composer for outgoing chat messages. Matches by aria-label prefix because
   * Meet decorates the label with context — e.g. `aria-label="Send a message
   * to everyone"` when the chat is broadcast to all participants. The `^=`
   * prefix match covers both the bare and decorated forms, mirroring the
   * approach used for `ASK_TO_JOIN_BUTTON`.
   *
   * We also accept `div[contenteditable="true"]` variants since some Meet
   * builds render the composer as a contenteditable div rather than a
   * textarea. Note that `chat.ts` currently writes via `.value`, which is a
   * textarea-only affordance — if Meet has migrated to contenteditable, the
   * selector will resolve but `sendChat` will silently no-op. That's a
   * follow-up (tracked in the PR body) and out of scope for this selector
   * drift fix.
   */
  // TODO(meet-dom): aria-label is localized. Future versions may need to
  // match multiple locales or fall back to role=textbox + placeholder.
  INPUT:
    'textarea[aria-label^="Send a message"], div[contenteditable="true"][aria-label^="Send a message"]',

  /**
   * Send button adjacent to the chat composer. Prefix match handles Meet's
   * decorated labels (e.g. "Send a message to everyone") the same way INPUT
   * does.
   */
  SEND_BUTTON: 'button[aria-label^="Send a message"]',

  /**
   * Container that holds the list of chat messages. Used to detect whether the
   * chat panel is open (the container is mounted even when no messages exist).
   */
  MESSAGE_LIST: '[role="list"][aria-label="Chat messages"]',

  /**
   * Root node for a single rendered chat message. We use a data attribute
   * rather than a class because Meet's message-list classes change often.
   */
  // TODO(meet-dom): Meet does not currently expose a stable per-message data
  // attribute. The selector below assumes we either inject a MutationObserver-
  // driven marker or rely on a recognizable ARIA structure. Verify during
  // fixture refresh and swap to whatever Meet actually emits.
  MESSAGE_NODE: 'div[role="listitem"][data-message-id]',

  /** Subselectors applied within a MESSAGE_NODE to extract rendered fields. */
  MESSAGE_SENDER: "[data-sender-name]",
  MESSAGE_TEXT: "[data-message-text]",
  MESSAGE_TIMESTAMP: "time[datetime]",
} as const;

/**
 * Participant-panel selectors. Like the chat panel, the participant list is
 * typically collapsed behind a toolbar toggle button.
 */
export const participantSelectors = {
  /** Toolbar toggle that opens the "People" side panel. */
  PANEL_BUTTON: 'button[aria-label="Show everyone"]',

  /** Container holding the list of participant rows. */
  LIST: '[role="list"][aria-label="Participants"]',

  /** A single participant row within the list. */
  NODE: '[role="listitem"][data-participant-id]',

  /** Subselectors applied within a NODE. */
  NAME: "[data-self-name], [data-participant-name]",

  /** Shown when a participant is currently presenting (screen-share). */
  // TODO(meet-dom): Meet varies between class-based and aria-based presenter
  // indicators across releases. Verify during fixture refresh.
  PRESENTER_INDICATOR: '[data-is-presenting="true"]',

  /**
   * Shown when a participant's mic level indicates they are speaking. Meet
   * toggles a class/attribute on the participant tile during speech; we target
   * it via a data attribute to keep the selector stable.
   */
  SPEAKING_INDICATOR: '[data-is-speaking="true"]',
} as const;

/**
 * Active-speaker indicator on the main meeting grid (not the participant
 * panel). Meet applies a border/outline class to the tile of the currently
 * loudest speaker; we read a corresponding data attribute.
 */
// TODO(meet-dom): In older Meet versions this was `.rG0ybd-tile-active`
// (minified class). The data attribute below is what we'd inject or observe;
// verify during fixture refresh.
export const INGAME_ACTIVE_SPEAKER_INDICATOR =
  '[data-participant-tile][data-active-speaker="true"]';

/**
 * In-meeting control-bar selectors (camera, microphone, leave).
 */
export const controlSelectors = {
  /**
   * Camera on/off toggle. Meet switches the aria-label between "Turn on
   * camera" and "Turn off camera" depending on state; we match either so the
   * selector works in both states.
   */
  CAMERA_TOGGLE:
    'button[aria-label="Turn off camera"], button[aria-label="Turn on camera"]',

  /**
   * Microphone on/off toggle. Same dual-aria-label pattern as the camera.
   */
  MIC_TOGGLE:
    'button[aria-label="Turn off microphone"], button[aria-label="Turn on microphone"]',

  /** Red "leave call" button in the center of the control bar. */
  LEAVE_BUTTON: 'button[aria-label="Leave call"]',

  /**
   * Post-admission-only "ready" indicator used as the canonical signal that
   * the bot has actually entered the meeting.
   *
   * Why this exists: the `LEAVE_BUTTON` selector (`button[aria-label="Leave
   * call"]`) is ambiguous — Meet renders the same red hang-up button in BOTH
   * the waiting-room UI AND the in-meeting UI, so `waitForSelector(LEAVE_
   * BUTTON)` resolves immediately after the user clicks "Ask to join",
   * BEFORE the host has actually admitted the bot. Callers that used
   * LEAVE_BUTTON as an admission signal (e.g. the join flow's step 5)
   * would then race ahead and try to interact with in-meeting surfaces
   * (chat panel, participant list) that don't exist in the waiting room,
   * producing spurious "chat input not found"-style failures.
   *
   * We re-use `MIC_TOGGLE` as the signal because the microphone toggle's
   * dual aria-label (`"Turn off microphone"` / `"Turn on microphone"`) is
   * a post-admission-only affordance — the waiting-room mic preview
   * controls use a different labeling scheme and are not rendered by the
   * bottom-bar toolbar that hosts this button. Matching MIC_TOGGLE
   * therefore guarantees the bot is inside the meeting (bottom toolbar
   * is mounted) rather than still on the prejoin surface.
   *
   * This constant is an alias for {@link MIC_TOGGLE}; it exists as a
   * separate name so the join flow reads clearly ("wait for the in-meeting
   * UI to be ready") and so future DOM drift can move the signal to a
   * different post-admission-only element without changing the call site.
   */
  INGAME_READY_INDICATOR:
    'button[aria-label="Turn off microphone"], button[aria-label="Turn on microphone"]',
} as const;

/**
 * Flat convenience object aggregating every selector group. Consumers can
 * destructure either the individual groups or the flat view depending on
 * which reads better at the call site.
 */
export const selectors = {
  // Prejoin
  PREJOIN_NAME_INPUT: prejoinSelectors.NAME_INPUT,
  PREJOIN_MEDIA_PROMPT_ACCEPT_BUTTON:
    prejoinSelectors.MEDIA_PROMPT_ACCEPT_BUTTON,
  PREJOIN_ASK_TO_JOIN_BUTTON: prejoinSelectors.ASK_TO_JOIN_BUTTON,
  PREJOIN_JOIN_NOW_BUTTON: prejoinSelectors.JOIN_NOW_BUTTON,

  // Chat
  INGAME_CHAT_PANEL_BUTTON: chatSelectors.PANEL_BUTTON,
  INGAME_CHAT_INPUT: chatSelectors.INPUT,
  INGAME_CHAT_SEND_BUTTON: chatSelectors.SEND_BUTTON,
  INGAME_CHAT_MESSAGE_LIST: chatSelectors.MESSAGE_LIST,
  INGAME_CHAT_MESSAGE_NODE: chatSelectors.MESSAGE_NODE,
  INGAME_CHAT_MESSAGE_SENDER: chatSelectors.MESSAGE_SENDER,
  INGAME_CHAT_MESSAGE_TEXT: chatSelectors.MESSAGE_TEXT,
  INGAME_CHAT_MESSAGE_TIMESTAMP: chatSelectors.MESSAGE_TIMESTAMP,

  // Participants
  INGAME_PARTICIPANTS_PANEL_BUTTON: participantSelectors.PANEL_BUTTON,
  INGAME_PARTICIPANT_LIST: participantSelectors.LIST,
  INGAME_PARTICIPANT_NODE: participantSelectors.NODE,
  INGAME_PARTICIPANT_NAME: participantSelectors.NAME,
  INGAME_PARTICIPANT_PRESENTER_INDICATOR:
    participantSelectors.PRESENTER_INDICATOR,
  INGAME_PARTICIPANT_SPEAKING_INDICATOR:
    participantSelectors.SPEAKING_INDICATOR,

  // Speaker
  INGAME_ACTIVE_SPEAKER_INDICATOR,

  // Controls
  INGAME_CAMERA_TOGGLE: controlSelectors.CAMERA_TOGGLE,
  INGAME_MIC_TOGGLE: controlSelectors.MIC_TOGGLE,
  INGAME_LEAVE_BUTTON: controlSelectors.LEAVE_BUTTON,
  INGAME_READY_INDICATOR: controlSelectors.INGAME_READY_INDICATOR,
} as const;

export type SelectorKey = keyof typeof selectors;
