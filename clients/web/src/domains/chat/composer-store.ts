/**
 * composer-store — Zustand store for chat composer state.
 *
 * Owns:
 * - Draft text input (per-conversation persistence to localStorage)
 * - File attachments (upload lifecycle, error state, blob URL management)
 * - "Draft restored" notice signal
 * - Failed sends held for the conversation each was composed for
 *
 * Both `ActiveChatView` (orchestration) and `ChatMainPanel` (rendering)
 * access this store directly — eliminating the 14-prop relay that previously
 * threaded draft + attachment state between them.
 *
 * Conversation-switch coordination is triggered by `chat-session-store`'s
 * `switchToConversation` action, which calls `handleConversationSwitch` (draft
 * save/restore) and either `resetAttachments` or `fullReset` (attachment
 * cleanup, with blob URL revocation on assistant switches).
 */

import { create } from "zustand";

import { t } from "@/i18n";
import { createSelectors } from "@/utils/create-selectors";
import type {
  AttachmentMetadata,
  DisplayAttachment,
} from "@/types/attachment-types";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { uploadChatAttachment } from "@/domains/chat/api/messages";
import {
  IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES,
  isAutoResizableImage,
  prepareImageAttachmentForUpload,
} from "@/domains/chat/components/chat-attachments/attachment-image-resize";
import { fetchAttachmentContentBlob } from "@/domains/chat/components/chat-attachments/download-attachment";
import {
  claimFailedSendBatch,
  type ClaimedFailedSendBatch,
  type CorrelatedFailedSend,
  hasClaimedFailedSend,
  mergeFailedSendEntries,
  settleClaimedFailedSendBatch,
} from "@/domains/chat/failed-send-recovery";
import { sniffBlobMimeType } from "@/utils/mime-sniff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Attachment metadata known before the upload completes — same server-canonical
 *  fields as {@link AttachmentMetadata} minus the server-assigned `id`. */
type LocalAttachmentMetadata = Omit<AttachmentMetadata, "id">;

/** Attachment that is currently being uploaded. */
export interface PendingAttachmentUpload extends LocalAttachmentMetadata {
  kind: "uploading";
  localId: string;
}

/** Attachment that successfully finished uploading and has a server-assigned id. */
export interface UploadedAttachment extends DisplayAttachment {
  kind: "uploaded";
  localId: string;
}

/** Attachment whose upload failed; kept in the list so the user can retry or dismiss. */
export interface FailedAttachmentUpload extends LocalAttachmentMetadata {
  kind: "failed";
  localId: string;
  error: string;
}

/**
 * Reference to a native filesystem path (e.g. a dropped folder in the Electron
 * desktop app). Unlike file attachments, nothing is uploaded — the path is
 * inserted into the sent message as textual context so the assistant knows
 * which folder to work with. The renderer only holds the path string.
 */
export interface PathReferenceAttachment {
  kind: "path-reference";
  localId: string;
  /** Absolute filesystem path resolved by the Electron host. */
  path: string;
  /** Basename shown in the chip UI (usually the folder name). */
  filename: string;
}

export type ChatAttachment =
  | PendingAttachmentUpload
  | UploadedAttachment
  | FailedAttachmentUpload
  | PathReferenceAttachment;

/**
 * Which composer instance a draft/attachment action targets. `"main"` is the
 * chat route's composer and is the default for every action, so call sites
 * that never pass `slot` keep reading/writing exactly the state they always
 * have. `"document"` is the independent draft/attachment bucket for the
 * composer pinned to a document editor (`MobileDocumentOverlay`, and on
 * mobile, the standalone document route): a separate slot rather than a
 * shared one, since the document composer targets a different conversation
 * than whatever the main composer is pointed at, and sharing state between
 * them would let typing in one clobber the other's in-progress draft.
 */
export type ComposerSlot = "main" | "document";

/** What a failed send carried: the text it was composed with and the
 *  attachments that went up with it. */
export interface FailedSendPayload {
  content: string;
  attachments: DisplayAttachment[];
}

type HeldFailedSend = CorrelatedFailedSend<FailedSendPayload>;

/** What an accepted send carried, plus the conversation it went to, so the
 *  message can be handed back to that thread from anywhere if persistence
 *  later fails. */
export interface QueuedSendPayload extends FailedSendPayload {
  /** The assistant the send went to, whose drafts a restored copy lives in. */
  assistantId: string;
  conversationId: string;
}

export interface ClaimedChatSendTransition {
  assistantId: string;
  conversationId: string;
  before: FailedSendPayload;
  after: FailedSendPayload | null;
  wasActiveBatch: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY_PREFIX = "vellum:chatDrafts:";

/**
 * Size limit enforced on the client before we attempt an upload. The Django
 * backend caps attachments at 50 MB (`_MAX_ATTACHMENT_BYTES`) — we use the same
 * value here so the UI can reject oversized files immediately instead of
 * round-tripping the upload just to surface an error.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** {@link MAX_ATTACHMENT_BYTES} as the catalog renders it. */
const MAX_ATTACHMENT_LABEL = "50 MB";

// ---------------------------------------------------------------------------
// localStorage helpers (draft persistence)
// ---------------------------------------------------------------------------

function draftStorageKey(assistantId: string): string {
  return `${STORAGE_KEY_PREFIX}${assistantId}`;
}

function loadDrafts(assistantId: string): Map<string, string> {
  const raw = getLocalSetting(draftStorageKey(assistantId), "");
  if (!raw) {
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

function persistDrafts(assistantId: string, drafts: Map<string, string>): void {
  setLocalSetting(
    draftStorageKey(assistantId),
    JSON.stringify(Object.fromEntries(drafts)),
  );
}

// ---------------------------------------------------------------------------
// Attachment helpers
// ---------------------------------------------------------------------------

function createLocalId(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function uploadLimitLabel(file: File): string {
  return isAutoResizableImage(file) ? "100 MB" : MAX_ATTACHMENT_LABEL;
}

/**
 * Whether an attachment is small enough to queue.
 *
 * Not a flat cap: an image this store will downscale on the way up is allowed
 * a larger source than one it has to send as-is.
 *
 * Takes the fields rather than a `File` so a caller holding only a picker's
 * metadata can ask the same question before it has any bytes. The native
 * pickers do exactly that, and read a file only once this has passed, so the
 * two paths cannot drift into reading what the store would then reject.
 */
export function canQueueFile(
  file: Pick<File, "name" | "type" | "size">,
): boolean {
  if (file.size <= MAX_ATTACHMENT_BYTES) {
    return true;
  }
  return (
    isAutoResizableImage(file) &&
    file.size <= IMAGE_AUTO_RESIZE_SOURCE_LIMIT_BYTES
  );
}

/**
 * Whether a file declared as an image holds bytes no image decoder can read.
 *
 * The declared type comes from the filename extension, so it is a claim, and
 * the bytes are what the model provider actually judges: an unreadable payload
 * costs the whole turn, since an OpenAI-compatible endpoint answers HTTP 400
 * for the entire request ("The image data you provided does not represent a
 * valid image"), taking every other image in the message down with it.
 *
 * Only a payload matching no known signature is refused here, not every payload
 * outside the four formats providers accept (PNG, JPEG, GIF, WebP): a HEIC
 * photo from an iPhone is none of the four and still attaches successfully,
 * because the assistant transcodes it to JPEG on the way into the attachment
 * store. Bytes that name nothing have no such route, so this is the subset that
 * is knowably unsendable from the browser. The provider send boundary is the
 * authoritative gate for the rest, and names the file in the transcript when it
 * drops one.
 */
async function isUnreadableImage(file: File): Promise<boolean> {
  if (!file.type.toLowerCase().startsWith("image/")) {
    return false;
  }
  return (await sniffBlobMimeType(file)) === null;
}

/** Extract the trailing path segment for the chip label, stripping any trailing separator. */
function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ComposerState {
  // --- Draft input (the "main" slot: the chat route composer) ---
  input: string;
  /** Which conversation's draft was most recently restored (for the "Draft restored" notice). */
  restoredDraftConversationId: string | null;

  // --- Attachments ("main" slot) ---
  attachments: ChatAttachment[];
  attachmentLastError: string | null;

  // --- "document" slot: the composer pinned to the mobile document editor.
  // No draft persistence (`draftsMap`), no restored-draft notice: those are
  // main-composer-only concerns (see `ComposerSlot`).
  documentInput: string;
  documentAttachments: ChatAttachment[];
  documentAttachmentLastError: string | null;

  /**
   * The messages of failed sends, keyed by the assistant and conversation each
   * was composed for (`failedSendFor` reads one), waiting for that exact
   * composer's return. A pair holding nothing has no entry.
   */
  failedSendsByConversation: ReadonlyMap<
    string,
    readonly HeldFailedSend[]
  >;

  /**
   * Accepted sends not yet confirmed as persisted, keyed by the nonce each
   * went out with. The composer is cleared the moment a send is handed off,
   * so until the assistant persists the message or refuses it this is the only
   * copy the client holds, and the transcript it was typed into is not:
   * leaving that conversation clears the optimistic row.
   */
  queuedSends: ReadonlyMap<string, QueuedSendPayload>;
  /** Recovery batches already copied into their conversation's composer. */
  claimedFailedSendBatches: ReadonlyMap<
    string,
    readonly ClaimedFailedSendBatch<FailedSendPayload>[]
  >;
}

export interface ComposerActions {
  // --- Draft input actions ---
  /** `slot` defaults to `"main"`: every existing call site is unaffected. */
  setInput: (
    value: string | ((prev: string) => string),
    slot?: ComposerSlot,
  ) => void;
  /**
   * Save a draft for the given conversation key. Call before operations
   * that wipe state but should preserve the user's text (e.g. pull-to-refresh).
   */
  saveDraft: (key: string, text: string) => void;
  /** Clear the draft for the given key (e.g. after a successful send). */
  clearDraft: (key: string) => void;
  /**
   * Put a failed send's text back into `key`'s draft slot, unless something is
   * already there.
   *
   * The composer clears the moment a send starts, so a send that fails after
   * the user has moved to another thread has nowhere on screen to put its text
   * back: the composer in front of them belongs to a different conversation.
   * Parking it in the draft map hands the message back the way any unsent draft
   * is handed back, the next time that thread is opened. The deep-link send
   * keeps a message for its target thread the same way when the user navigates
   * away mid-resolve (see `hooks/use-deep-link-thread-send.ts`).
   *
   * An occupied slot wins and this does nothing. Whatever is in there was
   * written after this send left, so it is the newer of the two, and it is what
   * the user last saw in that composer.
   *
   * For a thread that is NOT the one on screen: the write lands in the map, and
   * the composer picks it up on the switch that opens that conversation. A
   * caller restoring into the open thread would want {@link setInput} as well.
   *
   * `assistantId` is the assistant the SEND belonged to, which is not
   * necessarily the one loaded now: an assistant switch swaps the in-memory map
   * out from under a send still in flight. When the two agree this writes the
   * live map; when they do not it goes straight to that assistant's own
   * persisted entry, so the message waits where its own conversation will look
   * for it rather than being filed under a stranger.
   */
  restoreFailedDraft: (
    assistantId: string,
    key: string,
    text: string,
    clientMessageId?: string,
  ) => void;
  /**
   * Take back the draft a queued send wrote, once the assistant turns out to
   * have taken that message after all. A draft without matching provenance,
   * including one the user replaced with the same text, stays.
   */
  clearRestoredDraft: (clientMessageId: string) => void;
  /**
   * Replace a recovered payload only while `slot` still contains it exactly.
   * User edits or newly staged attachments always win.
   */
  replaceRecoveredPayload: (
    current: FailedSendPayload,
    replacement?: FailedSendPayload,
    slot?: ComposerSlot,
  ) => boolean;

  // --- Draft lifecycle (called by chat-session-store.switchToConversation) ---
  /**
   * Handle a conversation switch: save outgoing draft, restore incoming draft.
   * The draft-resolution early-return is handled by the caller before invoking
   * this action, so it always runs on genuine conversation switches.
   */
  handleConversationSwitch: (params: {
    previousKey: string | null;
    nextKey: string | null;
  }) => void;
  /**
   * Load the drafts map from localStorage for a new assistant.
   * Pass `currentConversationKey` so the current composer input can be saved
   * into the outgoing assistant's draft map before switching.
   */
  loadAssistantDrafts: (
    assistantId: string,
    currentConversationKey?: string | null,
  ) => void;
  /** Clear the restored draft notice. */
  clearRestoredDraftNotice: () => void;
  /**
   * Restore the saved draft for `key` into the composer — but only when the
   * composer is empty, so cold-load restore (page reload) never clobbers text
   * already present from a deep link or starter prefill. Surfaces the "Draft
   * restored" notice when it acts.
   */
  restoreDraftIfEmpty: (key: string) => void;

  // --- Attachment actions (`slot` defaults to `"main"`) ---
  addFiles: (
    files: FileList | File[],
    assistantId: string | null,
    slot?: ComposerSlot,
  ) => void;
  /**
   * Queue one or more native filesystem paths as `path-reference` attachments.
   * Nothing is uploaded — the path is included in the sent message content so
   * the assistant can operate against the folder in place.
   */
  addPathReferences: (paths: string[]) => void;
  removeAttachment: (localId: string, slot?: ComposerSlot) => void;
  /** Clear all attachments (e.g. after successful send). Does NOT revoke
   * preview URLs, since sent message bubbles still need them. */
  resetAttachments: (slot?: ComposerSlot) => void;
  /**
   * Stage already-uploaded attachments again, for a send the daemon reported
   * failed after the composer was cleared. Acts only while the slot holds no
   * attachments, so a newer set the user has staged since is never replaced.
   *
   * A restored attachment keeps its preview only while the store still holds
   * that preview alive, and otherwise comes back as a chip: a preview revoked
   * when its slot was cleared cannot be shown again.
   */
  restoreAttachmentsIfEmpty: (
    attachments: DisplayAttachment[],
    slot?: ComposerSlot,
  ) => void;
  /** Clear `slot`'s attachments AND revoke every preview URL that slot
   * created (e.g. on assistant switch), including the ones whose
   * attachments a previous `resetAttachments` already cleared into sent
   * message bubbles. The other slot's URLs are left alive, so resetting one
   * slot never frees blob URLs the other is still rendering. */
  fullReset: (slot?: ComposerSlot) => void;
  dismissAttachmentError: (slot?: ComposerSlot) => void;

  // --- Failed sends held for their own conversation ---
  /**
   * Hold the message of a failed send for the assistant and conversation it
   * was composed for, until that exact composer takes it back. A composer
   * already holding one keeps both, oldest first: the two drafts are joined by
   * a blank line and the attachments run one list after the other.
   */
  stashFailedSend: (
    assistantId: string,
    conversationId: string,
    payload: FailedSendPayload,
    clientMessageId?: string,
  ) => boolean;
  /**
   * Take the message held for the assistant and `conversationId`, removing it,
   * so one composer reclaims only what was composed there. Null when that
   * composer holds none.
   */
  takeFailedSend: (
    assistantId: string,
    conversationId: string,
  ) => FailedSendPayload | null;
  /**
   * Drop the held message only when it still exactly matches `payload`. An
   * eventual echo uses this to retract an ambiguous failure recovery without
   * deleting a newer or merged failure for the same composer.
   */
  dropFailedSend: (
    assistantId: string,
    conversationId: string,
    payload: FailedSendPayload,
  ) => boolean;
  /** Drop the provisional recovery correlated with `clientMessageId`. */
  dropFailedSendByClientMessageId: (clientMessageId: string) => boolean;
  /** Resolve one accepted or definitively failed component of a shown batch. */
  settleClaimedFailedSend: (
    clientMessageId: string,
    outcome: "accepted" | "failed",
  ) => ClaimedChatSendTransition | null;

  // --- Accepted sends awaiting authoritative persistence ---
  /**
   * Keep what an accepted send carried, under the nonce it went out with, for
   * as long as the assistant owes an authoritative persistence outcome.
   */
  recordQueuedSend: (
    clientMessageId: string,
    payload: QueuedSendPayload,
  ) => void;
  /**
   * Take the queued send `clientMessageId` names, removing it. Null when no
   * send is held under that nonce, which is every send this tab did not make.
   */
  takeQueuedSend: (clientMessageId: string) => QueuedSendPayload | null;
  /** Forget the queued send `clientMessageId` names, its message with it. */
  dropQueuedSend: (clientMessageId: string) => void;
  /** Drop every held and accepted send when no assistant context remains. */
  clearHeldSends: () => void;
}

type ComposerStore = ComposerState & ComposerActions;

/** The `failedSendsByConversation` key for one assistant's conversation. */
function failedSendKey(assistantId: string, conversationId: string): string {
  return `${assistantId}\u0000${conversationId}`;
}

/** The message held for `conversationId` under `assistantId`, if any. */
export function failedSendFor(
  state: Pick<ComposerState, "failedSendsByConversation">,
  assistantId: string,
  conversationId: string,
): FailedSendPayload | undefined {
  const held = state.failedSendsByConversation.get(
    failedSendKey(assistantId, conversationId),
  );
  return held === undefined ? undefined : mergeFailedSendEntries(held);
}

/** Whether the shown recovery batch still contains `clientMessageId`. */
export function isClaimedQueuedSend(
  state: Pick<ComposerState, "claimedFailedSendBatches">,
  clientMessageId: string,
): boolean {
  return hasClaimedFailedSend(
    state.claimedFailedSendBatches,
    clientMessageId,
  );
}

/** The assistant and conversation encoded by {@link failedSendKey}. */
function failedSendContext(key: string): {
  assistantId: string;
  conversationId: string;
} {
  const separator = key.indexOf("\u0000");
  return {
    assistantId: key.slice(0, separator),
    conversationId: key.slice(separator + 1),
  };
}

// ---------------------------------------------------------------------------
// Internal mutable state (not reactive — never triggers re-renders)
// ---------------------------------------------------------------------------

/** In-memory draft map — survives renders without causing them. */
let draftsMap = new Map<string, string>();
/** The assistant ID whose drafts are currently loaded. */
let currentAssistantId: string | null = null;
/** The conversation whose draft the main composer currently displays. */
let activeDraftConversationKey: string | null = null;
/** Draft writes owned by a queued send, keyed by that send's nonce. */
const restoredDraftOrigins = new Map<
  string,
  { assistantId: string; key: string; text: string }
>();

function forgetRestoredDraftOrigins(assistantId: string, key: string): void {
  for (const [clientMessageId, origin] of restoredDraftOrigins) {
    if (origin.assistantId === assistantId && origin.key === key) {
      restoredDraftOrigins.delete(clientMessageId);
    }
  }
}

function forgetChangedRestoredDraftOrigins(
  assistantId: string,
  key: string,
  text: string,
): void {
  for (const [clientMessageId, origin] of restoredDraftOrigins) {
    if (
      origin.assistantId === assistantId &&
      origin.key === key &&
      origin.text !== text
    ) {
      restoredDraftOrigins.delete(clientMessageId);
    }
  }
}

/**
 * Blob URLs for preview images, keyed by attachment local id and tagged with
 * the composer slot that created them. Revoked per attachment on removal and
 * per slot on assistant switch.
 */
const previewUrls = new Map<string, { url: string; slot: ComposerSlot }>();
/** Set of local IDs whose uploads have been cancelled. */
const cancelledUploads = new Set<string>();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useComposerStoreBase = create<ComposerStore>()((set, get) => ({
  // --- Initial state ---
  input: "",
  restoredDraftConversationId: null,
  attachments: [],
  attachmentLastError: null,
  documentInput: "",
  documentAttachments: [],
  documentAttachmentLastError: null,
  failedSendsByConversation: new Map(),
  queuedSends: new Map(),
  claimedFailedSendBatches: new Map(),

  // --- Draft input actions ---
  setInput: (value, slot = "main") => {
    if (slot === "document") {
      set((s) => ({
        documentInput:
          typeof value === "function" ? value(s.documentInput) : value,
      }));
      return;
    }
    set((s) => {
      const input = typeof value === "function" ? value(s.input) : value;
      if (
        input !== s.input &&
        currentAssistantId !== null &&
        activeDraftConversationKey !== null
      ) {
        forgetRestoredDraftOrigins(
          currentAssistantId,
          activeDraftConversationKey,
        );
      }
      return { input };
    });
  },

  saveDraft: (key, text) => {
    if (currentAssistantId !== null) {
      forgetChangedRestoredDraftOrigins(currentAssistantId, key, text);
    }
    if (text.trim()) {
      draftsMap.set(key, text);
    } else {
      draftsMap.delete(key);
    }
    if (currentAssistantId) {
      persistDrafts(currentAssistantId, draftsMap);
    }
  },

  clearDraft: (key) => {
    if (currentAssistantId !== null) {
      forgetRestoredDraftOrigins(currentAssistantId, key);
    }
    draftsMap.delete(key);
    if (currentAssistantId) {
      persistDrafts(currentAssistantId, draftsMap);
    }
  },

  restoreFailedDraft: (assistantId, key, text, clientMessageId) => {
    if (!text.trim()) {
      return;
    }
    // The map in memory belongs to whichever assistant is loaded. Reach for it
    // only when that is this send's assistant; otherwise read, check and write
    // that one's stored entry through the same helpers, so the two paths agree
    // on both the storage key and the serialized shape.
    const drafts =
      assistantId === currentAssistantId ? draftsMap : loadDrafts(assistantId);
    const existing = drafts.get(key);
    if (existing && existing.trim()) {
      return;
    }
    drafts.set(key, text);
    persistDrafts(assistantId, drafts);
    if (clientMessageId !== undefined) {
      forgetRestoredDraftOrigins(assistantId, key);
      restoredDraftOrigins.set(clientMessageId, { assistantId, key, text });
    }
  },

  clearRestoredDraft: (clientMessageId) => {
    const origin = restoredDraftOrigins.get(clientMessageId);
    if (origin === undefined) {
      return;
    }
    restoredDraftOrigins.delete(clientMessageId);
    const drafts =
      origin.assistantId === currentAssistantId
        ? draftsMap
        : loadDrafts(origin.assistantId);
    if (drafts.get(origin.key) !== origin.text) {
      return;
    }
    drafts.delete(origin.key);
    persistDrafts(origin.assistantId, drafts);
  },

  replaceRecoveredPayload: (current, replacement, slot = "main") => {
    const state = get();
    const input = slot === "document" ? state.documentInput : state.input;
    const attachments =
      slot === "document" ? state.documentAttachments : state.attachments;
    if (!composerMatchesFailedSend(input, attachments, current)) {
      return false;
    }
    state.setInput(replacement?.content ?? "", slot);
    state.resetAttachments(slot);
    if (replacement) {
      state.restoreAttachmentsIfEmpty(replacement.attachments, slot);
    }
    return true;
  },

  handleConversationSwitch: ({ previousKey, nextKey }) => {
    const isSwitch = previousKey !== null && previousKey !== nextKey;
    activeDraftConversationKey = nextKey;
    if (!isSwitch || !previousKey) {
      return;
    }

    // Save outgoing conversation's draft.
    const currentInput = get().input;
    if (currentAssistantId !== null) {
      forgetChangedRestoredDraftOrigins(
        currentAssistantId,
        previousKey,
        currentInput,
      );
    }
    if (currentInput.trim()) {
      draftsMap.set(previousKey, currentInput);
    } else {
      draftsMap.delete(previousKey);
    }

    // Restore incoming conversation's draft (or clear).
    const savedDraft = (nextKey && draftsMap.get(nextKey)) ?? "";
    set({
      input: savedDraft,
      restoredDraftConversationId:
        savedDraft.length > 0 && nextKey ? nextKey : null,
    });

    // Persist after the save/restore cycle.
    if (currentAssistantId) {
      persistDrafts(currentAssistantId, draftsMap);
    }
  },

  loadAssistantDrafts: (assistantId, currentConversationKey) => {
    // If switching assistants, save the current composer input into the
    // outgoing assistant's draft map before persisting. Without this, text
    // typed but not explicitly saved would be lost on assistant switch.
    if (currentAssistantId && currentAssistantId !== assistantId) {
      const input = get().input;
      if (currentConversationKey) {
        forgetChangedRestoredDraftOrigins(
          currentAssistantId,
          currentConversationKey,
          input,
        );
        if (input.trim()) {
          draftsMap.set(currentConversationKey, input);
        } else {
          draftsMap.delete(currentConversationKey);
        }
      }
      persistDrafts(currentAssistantId, draftsMap);
      // Reset input — the correct incoming draft (if any) will be restored
      // by handleConversationSwitch when it fires in the post-render effect.
      set({ input: "", restoredDraftConversationId: null });
    }
    draftsMap = loadDrafts(assistantId);
    currentAssistantId = assistantId;
    activeDraftConversationKey = null;
  },

  clearRestoredDraftNotice: () => {
    set({ restoredDraftConversationId: null });
  },

  restoreDraftIfEmpty: (key) => {
    activeDraftConversationKey = key;
    const saved = draftsMap.get(key);
    if (saved && saved.trim() && !get().input.trim()) {
      set({ input: saved, restoredDraftConversationId: key });
    }
  },

  // --- Attachment actions ---
  addFiles: (files, assistantId, slot = "main") => {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    if (!assistantId) {
      // The store runs outside React, so it reads the catalog through the
      // non-hook translator.
      setAttachmentError(
        set,
        slot,
        t("chat:composerAttachments.noActiveAssistant"),
      );
      return;
    }

    const oversized: File[] = [];
    const accepted: File[] = [];
    for (const file of list) {
      if (canQueueFile(file)) {
        accepted.push(file);
      } else {
        oversized.push(file);
      }
    }

    const firstOversized = oversized[0];
    if (firstOversized) {
      setAttachmentError(
        set,
        slot,
        oversized.length === 1
          ? t("chat:composerAttachments.fileTooLarge", {
              name: firstOversized.name,
              limit: uploadLimitLabel(firstOversized),
            })
          : t("chat:composerAttachments.filesTooLarge", {
              count: oversized.length,
            }),
      );
    } else {
      setAttachmentError(set, slot, null);
    }

    if (accepted.length === 0) {
      return;
    }

    const queued: Array<{ pending: PendingAttachmentUpload; file: File }> =
      accepted.map((file) => ({
        pending: {
          kind: "uploading" as const,
          localId: createLocalId(),
          filename: file.name || "attachment",
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
        file,
      }));

    updateAttachments(set, slot, (atts) => [
      ...atts,
      ...queued.map((entry) => entry.pending),
    ]);

    // Upload each file asynchronously.
    for (const { pending, file } of queued) {
      void (async () => {
        try {
          const prepared = await prepareImageAttachmentForUpload(file);
          if (cancelledUploads.has(pending.localId)) {
            cancelledUploads.delete(pending.localId);
            return;
          }

          if (prepared.status === "failed") {
            if (file.size > MAX_ATTACHMENT_BYTES) {
              markFailed(set, slot, pending.localId, prepared.error);
              return;
            }
          }

          const uploadFile =
            prepared.status === "failed" ? file : prepared.file;
          if (await isUnreadableImage(uploadFile)) {
            markFailed(
              set,
              slot,
              pending.localId,
              t("chat:composerAttachments.imageUnreadable"),
            );
            return;
          }
          if (uploadFile.size > MAX_ATTACHMENT_BYTES) {
            markFailed(
              set,
              slot,
              pending.localId,
              t("chat:composerAttachments.imageStillTooLargeAfterResize", {
                limit: MAX_ATTACHMENT_LABEL,
              }),
            );
            return;
          }

          if (prepared.status === "resized") {
            updateAttachments(set, slot, (atts) =>
              atts.map((att) =>
                att.localId === pending.localId && att.kind === "uploading"
                  ? {
                      ...att,
                      filename: uploadFile.name || "attachment",
                      mimeType: uploadFile.type || "application/octet-stream",
                      sizeBytes: uploadFile.size,
                    }
                  : att,
              ),
            );
          }

          const result = await uploadChatAttachment(assistantId, uploadFile);
          if (cancelledUploads.has(pending.localId)) {
            cancelledUploads.delete(pending.localId);
            return;
          }

          if (!result.ok) {
            markFailed(
              set,
              slot,
              pending.localId,
              result.error.detail ?? t("chat:composerAttachments.uploadFailed"),
            );
            return;
          }

          const localMime = uploadFile.type || "application/octet-stream";
          const storedFilename =
            result.filename ?? (uploadFile.name || "attachment");
          const storedMime = result.mimeType ?? localMime;
          const storedSize = result.sizeBytes ?? uploadFile.size;

          // When the assistant stores a different image format than the local
          // file (HEIC normalized to JPEG), the local bytes may not be
          // decodable by this renderer — preview the stored bytes instead.
          let previewSource: Blob = uploadFile;
          if (storedMime.startsWith("image/") && storedMime !== localMime) {
            const storedBlob = await fetchAttachmentContentBlob(
              assistantId,
              result.id,
            );
            if (cancelledUploads.has(pending.localId)) {
              cancelledUploads.delete(pending.localId);
              return;
            }
            if (storedBlob) {
              previewSource = storedBlob;
            }
          }

          let previewUrl: string | null = null;
          try {
            previewUrl = URL.createObjectURL(previewSource);
            previewUrls.set(pending.localId, { url: previewUrl, slot });
          } catch {
            previewUrl = null;
          }

          updateAttachments(set, slot, (atts) =>
            atts.map((att) =>
              att.localId === pending.localId
                ? ({
                    kind: "uploaded",
                    localId: pending.localId,
                    id: result.id,
                    filename: storedFilename,
                    mimeType: storedMime,
                    sizeBytes: storedSize,
                    previewUrl,
                    thumbnailUrl: null,
                  } satisfies UploadedAttachment)
                : att,
            ),
          );
        } catch {
          if (cancelledUploads.has(pending.localId)) {
            cancelledUploads.delete(pending.localId);
            return;
          }
          markFailed(
            set,
            slot,
            pending.localId,
            t("chat:composerAttachments.uploadFailed"),
          );
        }
      })();
    }
  },

  addPathReferences: (paths) => {
    const additions: PathReferenceAttachment[] = [];
    for (const path of paths) {
      const trimmed = path.trim();
      if (!trimmed) {
        continue;
      }
      additions.push({
        kind: "path-reference",
        localId: createLocalId(),
        path: trimmed,
        filename: basenameOf(trimmed) || trimmed,
      });
    }
    if (additions.length === 0) {
      return;
    }
    set((s) => ({
      attachments: [...s.attachments, ...additions],
      attachmentLastError: null,
    }));
  },

  removeAttachment: (localId, slot = "main") => {
    updateAttachments(set, slot, (atts) => {
      const target = atts.find((att) => att.localId === localId);
      if (target && target.kind === "uploading") {
        cancelledUploads.add(localId);
      }
      return atts.filter((att) => att.localId !== localId);
    });
    revokePreview(localId);
  },

  resetAttachments: (slot = "main") => {
    updateAttachments(set, slot, (atts) => {
      for (const att of atts) {
        if (att.kind === "uploading") {
          cancelledUploads.add(att.localId);
        }
      }
      return [];
    });
    // Intentionally do NOT revoke preview blob URLs here. After a successful
    // send the uploaded attachment chip is rendered inside the sent user
    // message bubble, which still needs those URLs. `fullReset` revokes every
    // URL this slot created, sent ones included, on assistant switch, and the
    // rest go on page unload.
    setAttachmentError(set, slot, null);
  },

  fullReset: (slot = "main") => {
    set((s) => {
      const atts = slot === "document" ? s.documentAttachments : s.attachments;
      for (const att of atts) {
        if (att.kind === "uploading") {
          cancelledUploads.add(att.localId);
        }
      }
      if (slot === "document") {
        return { documentAttachments: [], documentAttachmentLastError: null };
      }
      // Held failures and in-flight copies carry their assistant identity, so
      // they survive this visual reset without reaching the incoming
      // assistant's composer. Preview URLs are still revoked below; a restored
      // attachment returns as a chip when its preview is no longer alive.
      return {
        attachments: [],
        attachmentLastError: null,
      };
    });
    revokeSlotPreviews(slot);
  },

  restoreAttachmentsIfEmpty: (attachments, slot = "main") => {
    if (attachments.length === 0) {
      return;
    }
    updateAttachments(set, slot, (atts) => {
      if (atts.length > 0) {
        return atts;
      }
      return attachments.map((att) => {
        const localId = createLocalId();
        return {
          ...att,
          kind: "uploaded" as const,
          localId,
          previewUrl: previewUrlIfAlive(att.previewUrl, localId, slot),
        };
      });
    });
  },

  dismissAttachmentError: (slot = "main") => {
    setAttachmentError(set, slot, null);
  },

  stashFailedSend: (
    assistantId,
    conversationId,
    payload,
    clientMessageId,
  ) => {
    let stashed = false;
    set((s) => {
      const key = failedSendKey(assistantId, conversationId);
      const held = s.failedSendsByConversation.get(key) ?? [];
      if (
        clientMessageId !== undefined &&
        held.some((entry) => entry.clientMessageId === clientMessageId)
      ) {
        return s;
      }
      stashed = true;
      const next = new Map(s.failedSendsByConversation);
      next.set(key, [...held, { payload, clientMessageId }]);
      return { failedSendsByConversation: next };
    });
    return stashed;
  },

  takeFailedSend: (assistantId, conversationId) => {
    const key = failedSendKey(assistantId, conversationId);
    const held = get().failedSendsByConversation.get(key);
    if (held === undefined) {
      return null;
    }
    set((s) => {
      const next = new Map(s.failedSendsByConversation);
      next.delete(key);
      return {
        failedSendsByConversation: next,
        claimedFailedSendBatches: claimFailedSendBatch(
          s.claimedFailedSendBatches,
          key,
          held,
        ),
      };
    });
    return mergeFailedSendEntries(held);
  },

  dropFailedSend: (assistantId, conversationId, payload) => {
    const key = failedSendKey(assistantId, conversationId);
    const held = get().failedSendsByConversation.get(key);
    const index = held?.findIndex((entry) =>
      sameFailedSend(entry.payload, payload),
    );
    if (held === undefined || index === undefined || index === -1) {
      return false;
    }
    set((s) => {
      const next = new Map(s.failedSendsByConversation);
      const remaining = [
        ...held.slice(0, index),
        ...held.slice(index + 1),
      ];
      if (remaining.length === 0) {
        next.delete(key);
      } else {
        next.set(key, remaining);
      }
      return { failedSendsByConversation: next };
    });
    return true;
  },

  dropFailedSendByClientMessageId: (clientMessageId) => {
    const match = [...get().failedSendsByConversation].find(([, held]) =>
      held.some((entry) => entry.clientMessageId === clientMessageId),
    );
    if (!match) {
      return false;
    }
    const [key, held] = match;
    set((s) => {
      const next = new Map(s.failedSendsByConversation);
      const remaining = held.filter(
        (entry) => entry.clientMessageId !== clientMessageId,
      );
      if (remaining.length === 0) {
        next.delete(key);
      } else {
        next.set(key, remaining);
      }
      return { failedSendsByConversation: next };
    });
    return true;
  },

  settleClaimedFailedSend: (clientMessageId, outcome) => {
    const settled = settleClaimedFailedSendBatch(
      get().claimedFailedSendBatches,
      clientMessageId,
      outcome,
    );
    if (settled === null) {
      return null;
    }
    set({ claimedFailedSendBatches: settled.claimed });
    return {
      ...failedSendContext(settled.transition.key),
      before: settled.transition.before,
      after: settled.transition.after,
      wasActiveBatch: settled.transition.wasActiveBatch,
    };
  },

  recordQueuedSend: (clientMessageId, payload) => {
    set((s) => {
      const next = new Map(s.queuedSends);
      next.set(clientMessageId, payload);
      return { queuedSends: next };
    });
  },

  takeQueuedSend: (clientMessageId) => {
    const held = get().queuedSends.get(clientMessageId);
    if (held === undefined) {
      return null;
    }
    set((s) => {
      const next = new Map(s.queuedSends);
      next.delete(clientMessageId);
      return { queuedSends: next };
    });
    return held;
  },

  dropQueuedSend: (clientMessageId) => {
    if (!get().queuedSends.has(clientMessageId)) {
      return;
    }
    restoredDraftOrigins.delete(clientMessageId);
    get().settleClaimedFailedSend(clientMessageId, "failed");
    set((s) => {
      const next = new Map(s.queuedSends);
      next.delete(clientMessageId);
      return { queuedSends: next };
    });
  },

  clearHeldSends: () => {
    restoredDraftOrigins.clear();
    set((s) => {
      if (
        s.failedSendsByConversation.size === 0 &&
        s.queuedSends.size === 0 &&
        s.claimedFailedSendBatches.size === 0
      ) {
        return s;
      }
      return {
        failedSendsByConversation: new Map(),
        queuedSends: new Map(),
        claimedFailedSendBatches: new Map(),
      };
    });
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ComposerSetFn = (fn: (s: ComposerState) => Partial<ComposerState>) => void;

/** Whether a held recovery is still exactly the send an eventual echo names. */
function sameFailedSend(
  left: FailedSendPayload,
  right: FailedSendPayload,
): boolean {
  return (
    left.content === right.content &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every(
      (attachment, index) => attachment.id === right.attachments[index]?.id,
    )
  );
}

/** Whether one composer slot still displays exactly `payload`. */
function composerMatchesFailedSend(
  input: string,
  attachments: readonly ChatAttachment[],
  payload: FailedSendPayload,
): boolean {
  return (
    input === payload.content &&
    attachments.length === payload.attachments.length &&
    attachments.every(
      (attachment, index) =>
        attachment.kind === "uploaded" &&
        attachment.id === payload.attachments[index]?.id,
    )
  );
}

/** Read/write the attachment list belonging to `slot`, main or document. */
function updateAttachments(
  set: ComposerSetFn,
  slot: ComposerSlot,
  updater: (atts: ChatAttachment[]) => ChatAttachment[],
) {
  if (slot === "document") {
    set((s) => ({ documentAttachments: updater(s.documentAttachments) }));
    return;
  }
  set((s) => ({ attachments: updater(s.attachments) }));
}

/** Set the attachment-error banner belonging to `slot`, main or document. */
function setAttachmentError(
  set: ComposerSetFn,
  slot: ComposerSlot,
  error: string | null,
) {
  if (slot === "document") {
    set(() => ({ documentAttachmentLastError: error }));
    return;
  }
  set(() => ({ attachmentLastError: error }));
}

function markFailed(
  set: ComposerSetFn,
  slot: ComposerSlot,
  localId: string,
  detail: string,
) {
  updateAttachments(set, slot, (atts) =>
    atts.map((att) => {
      // Only uploading attachments can transition to failed — path-references
      // and already-uploaded rows aren't part of the upload flow.
      if (att.localId !== localId || att.kind !== "uploading") {
        return att;
      }
      return {
        kind: "failed",
        localId,
        filename: att.filename,
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
        error: detail,
      } satisfies FailedAttachmentUpload;
    }),
  );
}

function revokePreview(localId: string) {
  const entry = previewUrls.get(localId);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    previewUrls.delete(localId);
  }
}

/**
 * The preview URL an attachment being staged again under `newLocalId` can still
 * render, or `null` when the store no longer holds that URL alive and it is
 * therefore already revoked. A URL that survives is re-registered under
 * `newLocalId` for `slot`, so the slot's next full reset revokes it once.
 */
function previewUrlIfAlive(
  previewUrl: string | null | undefined,
  newLocalId: string,
  slot: ComposerSlot,
): string | null {
  if (!previewUrl) {
    return null;
  }
  for (const [localId, entry] of previewUrls) {
    if (entry.url !== previewUrl) {
      continue;
    }
    previewUrls.delete(localId);
    previewUrls.set(newLocalId, { url: previewUrl, slot });
    return previewUrl;
  }
  return null;
}

/**
 * Revoke every preview URL `slot` created, whether its attachment is still
 * staged or was cleared into a sent message bubble by `resetAttachments`.
 */
function revokeSlotPreviews(slot: ComposerSlot) {
  for (const [localId, entry] of previewUrls) {
    if (entry.slot === slot) {
      URL.revokeObjectURL(entry.url);
      previewUrls.delete(localId);
    }
  }
}

// ---------------------------------------------------------------------------
// Derived selectors (not reactive state — compute in consumers)
// ---------------------------------------------------------------------------

/** Number of attachments currently uploading. */
export function selectUploadingCount(attachments: ChatAttachment[]): number {
  return attachments.reduce(
    (acc, att) => (att.kind === "uploading" ? acc + 1 : acc),
    0,
  );
}

/** Ids of successfully-uploaded attachments, in insertion order. */
export function selectUploadedIds(attachments: ChatAttachment[]): string[] {
  return attachments
    .filter((att): att is UploadedAttachment => att.kind === "uploaded")
    .map((att) => att.id);
}

/** Native filesystem paths queued as path-reference attachments, in insertion order. */
export function selectPathReferencePaths(
  attachments: ChatAttachment[],
): string[] {
  return attachments
    .filter(
      (att): att is PathReferenceAttachment => att.kind === "path-reference",
    )
    .map((att) => att.path);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const useComposerStore = createSelectors(useComposerStoreBase);
