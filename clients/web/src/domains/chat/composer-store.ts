/**
 * composer-store — Zustand store for chat composer state.
 *
 * Owns:
 * - Draft text input (per-conversation persistence to localStorage)
 * - File attachments (upload lifecycle, error state, blob URL management)
 * - "Draft restored" notice signal
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
import { sniffBlobMimeType } from "@/domains/chat/utils/mime-sniff";

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
  return isAutoResizableImage(file) ? "100 MB" : "50 MB";
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

/** Chip error for an image whose bytes are not an image at all. */
const UNREADABLE_IMAGE_ERROR =
  "This image can't be sent: the file appears to be corrupt or in an unsupported format.";

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
  // --- Draft input ---
  input: string;
  /** Which conversation's draft was most recently restored (for the "Draft restored" notice). */
  restoredDraftConversationId: string | null;

  // --- Attachments ---
  attachments: ChatAttachment[];
  attachmentLastError: string | null;
}

export interface ComposerActions {
  // --- Draft input actions ---
  setInput: (value: string | ((prev: string) => string)) => void;
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
  restoreFailedDraft: (assistantId: string, key: string, text: string) => void;

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

  // --- Attachment actions ---
  addFiles: (files: FileList | File[], assistantId: string | null) => void;
  /**
   * Queue one or more native filesystem paths as `path-reference` attachments.
   * Nothing is uploaded — the path is included in the sent message content so
   * the assistant can operate against the folder in place.
   */
  addPathReferences: (paths: string[]) => void;
  removeAttachment: (localId: string) => void;
  /** Clear all attachments (e.g. after successful send). Does NOT revoke
   * preview URLs — sent message bubbles still need them. */
  resetAttachments: () => void;
  /** Clear all attachments AND revoke preview URLs (e.g. on assistant switch). */
  fullReset: () => void;
  dismissAttachmentError: () => void;
}

type ComposerStore = ComposerState & ComposerActions;

// ---------------------------------------------------------------------------
// Internal mutable state (not reactive — never triggers re-renders)
// ---------------------------------------------------------------------------

/** In-memory draft map — survives renders without causing them. */
let draftsMap = new Map<string, string>();
/** The assistant ID whose drafts are currently loaded. */
let currentAssistantId: string | null = null;
/** Blob URLs for preview images — revoked on assistant switch or unmount. */
const previewUrls = new Map<string, string>();
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

  // --- Draft input actions ---
  setInput: (value) => {
    set((s) => ({
      input: typeof value === "function" ? value(s.input) : value,
    }));
  },

  saveDraft: (key, text) => {
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
    draftsMap.delete(key);
    if (currentAssistantId) {
      persistDrafts(currentAssistantId, draftsMap);
    }
  },

  restoreFailedDraft: (assistantId, key, text) => {
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
  },

  handleConversationSwitch: ({ previousKey, nextKey }) => {
    const isSwitch = previousKey !== null && previousKey !== nextKey;
    if (!isSwitch || !previousKey) {
      return;
    }

    // Save outgoing conversation's draft.
    const currentInput = get().input;
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
  },

  clearRestoredDraftNotice: () => {
    set({ restoredDraftConversationId: null });
  },

  restoreDraftIfEmpty: (key) => {
    const saved = draftsMap.get(key);
    if (saved && saved.trim() && !get().input.trim()) {
      set({ input: saved, restoredDraftConversationId: key });
    }
  },

  // --- Attachment actions ---
  addFiles: (files, assistantId) => {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    if (!assistantId) {
      set({ attachmentLastError: "No active assistant. Please try again." });
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
      set({
        attachmentLastError:
          oversized.length === 1
            ? `${firstOversized.name} is larger than ${uploadLimitLabel(firstOversized)} and can't be attached.`
            : `${oversized.length} files are too large and can't be attached.`,
      });
    } else {
      set({ attachmentLastError: null });
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

    set((s) => ({
      attachments: [...s.attachments, ...queued.map((entry) => entry.pending)],
    }));

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
              markFailed(set, pending.localId, prepared.error);
              return;
            }
          }

          const uploadFile =
            prepared.status === "failed" ? file : prepared.file;
          if (await isUnreadableImage(uploadFile)) {
            markFailed(set, pending.localId, UNREADABLE_IMAGE_ERROR);
            return;
          }
          if (uploadFile.size > MAX_ATTACHMENT_BYTES) {
            markFailed(
              set,
              pending.localId,
              "This attachment is still larger than 50 MB after resizing. Try a smaller image.",
            );
            return;
          }

          if (prepared.status === "resized") {
            set((s) => ({
              attachments: s.attachments.map((att) =>
                att.localId === pending.localId && att.kind === "uploading"
                  ? {
                      ...att,
                      filename: uploadFile.name || "attachment",
                      mimeType: uploadFile.type || "application/octet-stream",
                      sizeBytes: uploadFile.size,
                    }
                  : att,
              ),
            }));
          }

          const result = await uploadChatAttachment(assistantId, uploadFile);
          if (cancelledUploads.has(pending.localId)) {
            cancelledUploads.delete(pending.localId);
            return;
          }

          if (!result.ok) {
            markFailed(
              set,
              pending.localId,
              result.error.detail ?? "Upload failed",
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
            previewUrls.set(pending.localId, previewUrl);
          } catch {
            previewUrl = null;
          }

          set((s) => ({
            attachments: s.attachments.map((att) =>
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
          }));
        } catch {
          if (cancelledUploads.has(pending.localId)) {
            cancelledUploads.delete(pending.localId);
            return;
          }
          markFailed(set, pending.localId, "Upload failed");
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

  removeAttachment: (localId) => {
    set((s) => {
      const target = s.attachments.find((att) => att.localId === localId);
      if (target && target.kind === "uploading") {
        cancelledUploads.add(localId);
      }
      return {
        attachments: s.attachments.filter((att) => att.localId !== localId),
      };
    });
    revokePreview(localId);
  },

  resetAttachments: () => {
    set((s) => {
      for (const att of s.attachments) {
        if (att.kind === "uploading") {
          cancelledUploads.add(att.localId);
        }
      }
      // Intentionally do NOT revoke preview blob URLs here. After a successful
      // send the uploaded attachment chip is rendered inside the sent user
      // message bubble, which still needs those URLs. They get revoked on
      // assistant switch (fullReset) and on page unload.
      return { attachments: [], attachmentLastError: null };
    });
  },

  fullReset: () => {
    set((s) => {
      for (const att of s.attachments) {
        if (att.kind === "uploading") {
          cancelledUploads.add(att.localId);
        }
      }
      return { attachments: [], attachmentLastError: null };
    });
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.clear();
  },

  dismissAttachmentError: () => {
    set({ attachmentLastError: null });
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function markFailed(
  set: (fn: (s: ComposerState) => Partial<ComposerState>) => void,
  localId: string,
  detail: string,
) {
  set((s) => ({
    attachments: s.attachments.map((att) => {
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
  }));
}

function revokePreview(localId: string) {
  const url = previewUrls.get(localId);
  if (url) {
    URL.revokeObjectURL(url);
    previewUrls.delete(localId);
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
