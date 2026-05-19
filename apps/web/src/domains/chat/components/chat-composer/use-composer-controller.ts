import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { searchEmoji, type EmojiEntry } from "@/domains/chat/components/chat-composer/emoji-catalog.js";
import { filteredCommands, type SlashCommand } from "@/domains/chat/components/chat-composer/slash-command-catalog.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposerControllerState {
  showSlashMenu: boolean;
  slashFilter: string;
  slashSelectedIndex: number;
  slashCommands: SlashCommand[];
}

export interface EmojiControllerState {
  showEmojiMenu: boolean;
  emojiFilter: string;
  emojiSelectedIndex: number;
  emojiEntries: EmojiEntry[];
}

export interface ComposerControllerActions {
  onTextChange: (text: string, cursorPosition?: number) => void;
  handleSlashUp: () => void;
  handleSlashDown: () => void;
  handleSlashSelect: () => SlashCommand | null;
  handleSlashDismiss: () => void;
  handleEmojiUp: () => void;
  handleEmojiDown: () => void;
  handleEmojiSelect: () => EmojiEntry | null;
  handleEmojiDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Pure state-machine helpers (exported for unit testing)
// ---------------------------------------------------------------------------

export const SLASH_PREFIX_RE = /^\/(\w*)$/;

/** Matches `:shortcode` at the end of text up to the cursor position.
 *  Allows `+` and `-` so shortcodes like `:+1` and `:-1` are matched. */
export const EMOJI_TRIGGER_RE = /:([\w+-]+)$/;

/** Minimum filter length before showing the emoji popup. */
const EMOJI_MIN_FILTER_LENGTH = 2;

const INITIAL_STATE: ComposerControllerState = {
  showSlashMenu: false,
  slashFilter: "",
  slashSelectedIndex: 0,
  slashCommands: [],
};

const INITIAL_EMOJI_STATE: EmojiControllerState = {
  showEmojiMenu: false,
  emojiFilter: "",
  emojiSelectedIndex: 0,
  emojiEntries: [],
};

/**
 * Pure function that computes the next slash-menu state given the current
 * input text and whether reopen is suppressed.
 *
 * Returns `[nextState, consumedSuppress]`. When `consumedSuppress` is true
 * the caller should clear its suppress flag.
 */
export function computeSlashState(
  text: string,
  suppressed: boolean,
): [ComposerControllerState, boolean] {
  const match = SLASH_PREFIX_RE.exec(text);

  if (!match) {
    // No slash prefix — also consume suppress so dismissing then clearing
    // the input doesn't leak the flag and swallow the next "/" keystroke.
    return [INITIAL_STATE, suppressed];
  }

  if (suppressed) {
    // Consume the suppress flag. Compute the real filter/commands from the
    // current input so filter tracks correctly, but keep the menu hidden.
    // This way the next keystroke (suppress already cleared) can reopen the
    // menu without requiring an extra keystroke to rebuild the filter.
    const filter = match[1] ?? "";
    const matches = filteredCommands(filter);
    return [{ showSlashMenu: false, slashFilter: filter, slashSelectedIndex: 0, slashCommands: matches }, true];
  }

  const filter = match[1] ?? "";
  const matches = filteredCommands(filter);

  if (matches.length === 0) {
    return [{ showSlashMenu: false, slashFilter: filter, slashSelectedIndex: 0, slashCommands: [] }, false];
  }

  return [{ showSlashMenu: true, slashFilter: filter, slashSelectedIndex: 0, slashCommands: matches }, false];
}

/** Compute next selected index when moving up in a list (wraps around). */
export function listIndexUp(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current <= 0 ? listLength - 1 : current - 1;
}

/** Compute next selected index when moving down in a list (wraps around). */
export function listIndexDown(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current >= listLength - 1 ? 0 : current + 1;
}

/**
 * Pure function that computes the next emoji-menu state given the input text
 * up to the cursor position. Port of `updateEmojiState()` from
 * ComposerController.swift.
 *
 * The trigger is a `:word` pattern at the end of the text-before-cursor.
 * The popup shows when the filter has >= 2 chars and there are matching results.
 */
export function computeEmojiState(
  textBeforeCursor: string,
  suppressed: boolean,
): [EmojiControllerState, boolean] {
  const match = EMOJI_TRIGGER_RE.exec(textBeforeCursor);

  if (!match) {
    return [INITIAL_EMOJI_STATE, suppressed];
  }

  const filter = match[1] ?? "";

  if (filter.length < EMOJI_MIN_FILTER_LENGTH) {
    return [INITIAL_EMOJI_STATE, suppressed];
  }

  if (suppressed) {
    const entries = searchEmoji(filter);
    return [
      { showEmojiMenu: false, emojiFilter: filter, emojiSelectedIndex: 0, emojiEntries: entries },
      true,
    ];
  }

  const entries = searchEmoji(filter);

  if (entries.length === 0) {
    return [
      { showEmojiMenu: false, emojiFilter: filter, emojiSelectedIndex: 0, emojiEntries: [] },
      false,
    ];
  }

  return [
    { showEmojiMenu: true, emojiFilter: filter, emojiSelectedIndex: 0, emojiEntries: entries },
    false,
  ];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useComposerController(): [ComposerControllerState, EmojiControllerState, ComposerControllerActions] {
  const [state, setState] = useState<ComposerControllerState>(INITIAL_STATE);
  const [emojiState, setEmojiState] = useState<EmojiControllerState>(INITIAL_EMOJI_STATE);

  // Mirror state in refs so select handlers can read current values
  // synchronously without depending on when React flushes the setState updater.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const emojiStateRef = useRef(emojiState);
  useEffect(() => {
    emojiStateRef.current = emojiState;
  });

  // Ref — survives exactly one render cycle without triggering re-render.
  const suppressSlashReopen = useRef(false);
  const suppressEmojiReopen = useRef(false);

  const onTextChange = useCallback((text: string, cursorPosition?: number) => {
    // Slash state — only triggers on full-input match (e.g. "/cmd")
    const [nextSlash, slashConsumed] = computeSlashState(text, suppressSlashReopen.current);
    if (slashConsumed) {
      suppressSlashReopen.current = false;
    }
    setState(nextSlash);

    // Emoji state — looks at text before cursor for `:shortcode` pattern
    const cursor = cursorPosition ?? text.length;
    const textBeforeCursor = text.slice(0, cursor);
    const [nextEmoji, emojiConsumed] = computeEmojiState(textBeforeCursor, suppressEmojiReopen.current);
    if (emojiConsumed) {
      suppressEmojiReopen.current = false;
    }
    setEmojiState(nextEmoji);
  }, []);

  // --- Slash actions ---

  const handleSlashUp = useCallback(() => {
    setState((prev) => ({
      ...prev,
      slashSelectedIndex: listIndexUp(prev.slashSelectedIndex, prev.slashCommands.length),
    }));
  }, []);

  const handleSlashDown = useCallback(() => {
    setState((prev) => ({
      ...prev,
      slashSelectedIndex: listIndexDown(prev.slashSelectedIndex, prev.slashCommands.length),
    }));
  }, []);

  const handleSlashSelect = useCallback((): SlashCommand | null => {
    // Read selected command from the ref BEFORE calling setState, so the
    // return value doesn't depend on when React flushes the updater.
    const cur = stateRef.current;
    if (!cur.showSlashMenu || cur.slashCommands.length === 0) return null;
    const selected = cur.slashCommands[cur.slashSelectedIndex] ?? null;
    setState((prev) => ({ ...prev, showSlashMenu: false }));
    return selected;
  }, []);

  const handleSlashDismiss = useCallback(() => {
    setState((prev) => ({ ...prev, showSlashMenu: false }));
    suppressSlashReopen.current = true;
  }, []);

  // --- Emoji actions ---

  const handleEmojiUp = useCallback(() => {
    setEmojiState((prev) => ({
      ...prev,
      emojiSelectedIndex: listIndexUp(prev.emojiSelectedIndex, prev.emojiEntries.length),
    }));
  }, []);

  const handleEmojiDown = useCallback(() => {
    setEmojiState((prev) => ({
      ...prev,
      emojiSelectedIndex: listIndexDown(prev.emojiSelectedIndex, prev.emojiEntries.length),
    }));
  }, []);

  const handleEmojiSelect = useCallback((): EmojiEntry | null => {
    const cur = emojiStateRef.current;
    if (!cur.showEmojiMenu || cur.emojiEntries.length === 0) return null;
    const selected = cur.emojiEntries[cur.emojiSelectedIndex] ?? null;
    setEmojiState((prev) => ({ ...prev, showEmojiMenu: false }));
    return selected;
  }, []);

  const handleEmojiDismiss = useCallback(() => {
    setEmojiState((prev) => ({ ...prev, showEmojiMenu: false }));
    suppressEmojiReopen.current = true;
  }, []);

  const actions: ComposerControllerActions = useMemo(() => ({
    onTextChange,
    handleSlashUp,
    handleSlashDown,
    handleSlashSelect,
    handleSlashDismiss,
    handleEmojiUp,
    handleEmojiDown,
    handleEmojiSelect,
    handleEmojiDismiss,
  }), [
    onTextChange,
    handleSlashUp,
    handleSlashDown,
    handleSlashSelect,
    handleSlashDismiss,
    handleEmojiUp,
    handleEmojiDown,
    handleEmojiSelect,
    handleEmojiDismiss,
  ]);

  return [state, emojiState, actions];
}
