/**
 * Fixtures for the Chat Info tests and stories: the two daemon summaries the
 * panel lists, and the assets it renders as tiles.
 *
 * Every asset goes through `toConversationFileAssets`, the mapping the hook
 * itself runs, so a fixture cannot drift from the ids and shapes the panel
 * receives in the app.
 *
 * Kept free of any test-runner import so `.stories.tsx` files can use it, the
 * way `utils/conversation-list.test-helper.ts` already is.
 */

import {
  type ConversationFileAsset,
  toConversationFileAssets,
} from "@/domains/chat/hooks/use-conversation-assets";
import type { ConversationAttachmentEntry } from "@/domains/chat/hooks/use-conversation-attachments";
import type { AppSummary } from "@/types/app-types";
import type { DisplayAttachment } from "@/types/attachment-types";
import type { DocumentSummary } from "@/types/document-types";

/** Fixed epoch ms, so nothing built here depends on the clock. */
export const CHAT_INFO_T0 = 1_760_000_000_000;

/** A daemon app summary with every field defaulted, `overrides` on top. */
export function makeAppSummary(
  overrides: Partial<AppSummary> = {},
): AppSummary {
  const id = overrides.id ?? "app-1";
  return {
    id,
    name: "Trip Planner",
    icon: "🧭",
    createdAt: CHAT_INFO_T0,
    updatedAt: CHAT_INFO_T0,
    version: "1.0.0",
    contentId: `${id}-content`,
    origin: "workspace",
    ...overrides,
  };
}

/** A daemon document summary with every field defaulted, `overrides` on top. */
export function makeDocumentSummary(
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  const surfaceId = overrides.surfaceId ?? "surface-1";
  return {
    surfaceId,
    conversationId: "conv-1",
    title: "Trip Notes",
    wordCount: 120,
    createdAt: CHAT_INFO_T0,
    updatedAt: CHAT_INFO_T0,
    ...overrides,
  };
}

/**
 * One attachment entry as the transcript path produces it. The key is the
 * attachment's own id, which is what the hook uses for anything but a legacy
 * `rehydrated:N` row.
 */
export function makeAttachmentEntry(
  attachment: DisplayAttachment,
  overrides: Partial<Omit<ConversationAttachmentEntry, "attachment">> = {},
): ConversationAttachmentEntry {
  return {
    key: attachment.id,
    attachment,
    messageId: "msg-1",
    capturedAt: null,
    sightFrame: false,
    ...overrides,
  };
}

/** One document as the file asset the panel hands a tile. */
export function makeDocumentAsset(doc: DocumentSummary): ConversationFileAsset {
  return toConversationFileAssets([doc], []).files[0]!;
}

/** One attachment as the file asset the panel hands a tile. */
export function makeFileAsset(
  attachment: DisplayAttachment,
): ConversationFileAsset {
  return toConversationFileAssets([], [makeAttachmentEntry(attachment)])
    .files[0]!;
}

/** One attachment as the camera-frame asset the panel hands a tile. */
export function makeFrameAsset(
  attachment: DisplayAttachment,
  capturedAt: number | null,
): ConversationFileAsset {
  return toConversationFileAssets(
    [],
    [makeAttachmentEntry(attachment, { sightFrame: true, capturedAt })],
  ).frames[0]!;
}
