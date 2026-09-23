/**
 * Projection from a stored conversation row to what a contact may read.
 *
 * A contact reads a shared conversation through its own routes, and every row
 * those routes return passes through here first. The projection is an
 * allowlist: a block reaches a contact only when its type is named below, so
 * anything else (reasoning, tool calls and their results, UI cards, and any
 * block type added later) stays invisible until it is explicitly allowed.
 * {@link contactVisibleBlock} switches exhaustively over the stored block
 * union, so a new variant does not compile until it is classified here.
 *
 * The guardian's own read path does not use this module.
 */

import { MessageAudienceSchema } from "@vellumai/gateway-client";

import {
  readChannelDeletedAt,
  readProviderMetadata,
} from "../messaging/read-provider-metadata.js";
import type {
  ContentBlock,
  TextContent,
  WorkspaceRefMediaSource,
} from "../providers/types.js";
import {
  containsNoResponseMarker,
  stripNoResponseMarkers,
} from "../runtime/no-response.js";
import { isPlainObject } from "../util/object.js";
import {
  isEchoSuppressedUserMessage,
  isNoResponseMetadata,
  isReactionMessageMetadata,
} from "./conversation-types.js";
import {
  isPrivateAssistantText,
  projectUserFacingContent,
} from "./user-facing-content.js";

/**
 * Metadata key that restricts a stored row to one reader, holding a
 * `MessageAudience` in the channel's own id space. For a contact that id is
 * their principal id.
 */
export const MESSAGE_AUDIENCE_METADATA_KEY = "audience";

/** The contact a row is projected for. */
export interface ContactReader {
  principalId: string;
}

/**
 * A stored row: its role, its resolved content blocks, and its raw or parsed
 * metadata.
 */
export interface StoredRowForContact {
  role: string;
  content: ContentBlock[];
  metadata: unknown;
}

/**
 * A text block, carrying the persist path's `_redactionVersion` rider so a
 * renderer can tell redactor-authored sentinels from forged ones.
 */
export type ContactVisibleText = TextContent & { _redactionVersion?: number };

/** An attachment, as a reference into the attachment store and never bytes. */
export interface ContactVisibleAttachment {
  type: "image" | "file";
  source: WorkspaceRefMediaSource;
}

export type ContactVisibleBlock = ContactVisibleText | ContactVisibleAttachment;

/**
 * The row's metadata as a record, `{}` when the row has none, or null when it
 * is present but unreadable.
 */
function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (metadata === null || metadata === undefined) {
    return {};
  }
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return null;
    }
  }
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * Whether a row's audience admits this reader. A row with no audience is
 * visible to every participant; a restricted row only to its addressee. An
 * audience that does not parse admits nobody.
 */
function audienceAdmits(
  metadata: Record<string, unknown>,
  reader: ContactReader,
): boolean {
  const raw = metadata[MESSAGE_AUDIENCE_METADATA_KEY];
  if (raw === undefined) {
    return true;
  }
  const audience = MessageAudienceSchema.safeParse(raw);
  return audience.success && audience.data.userId === reader.principalId;
}

/**
 * Whether the row records a reaction, in either direction. Its text is a
 * storage sentinel and the reaction itself lives in the metadata envelope.
 */
function isReactionRow(
  metadata: Record<string, unknown>,
  metadataJson: string,
): boolean {
  return (
    isReactionMessageMetadata(metadata) ||
    (metadataJson.includes("reaction") &&
      readProviderMetadata(metadataJson, { allowFlatLegacy: true })
        ?.eventKind === "reaction")
  );
}

function referenceSource(source: unknown): WorkspaceRefMediaSource | null {
  if (!isPlainObject(source) || source.type !== "workspace_ref") {
    return null;
  }
  const { media_type, attachmentId, sizeBytes, filename, width, height } =
    source;
  if (
    typeof media_type !== "string" ||
    typeof attachmentId !== "string" ||
    attachmentId.length === 0 ||
    typeof sizeBytes !== "number"
  ) {
    return null;
  }
  return {
    type: "workspace_ref",
    media_type,
    attachmentId,
    sizeBytes,
    ...(typeof filename === "string" ? { filename } : {}),
    ...(typeof width === "number" ? { width } : {}),
    ...(typeof height === "number" ? { height } : {}),
  };
}

/**
 * The contact-visible form of one block, or null when a contact may not see
 * it. Each allowed block is rebuilt from its known fields, so internal riders
 * and fields added to a block later never ride along. On an assistant row the
 * `<no_response/>` sentinel is stripped from text, and a block left empty is
 * dropped.
 */
function contactVisibleBlock(
  block: ContentBlock,
  isAssistant: boolean,
): ContactVisibleBlock | null {
  switch (block.type) {
    case "text": {
      // The plain-text twin of a UI card, which a contact does not see.
      const extra = block as { _surfaceFallback?: unknown };
      if (typeof block.text !== "string" || extra._surfaceFallback === true) {
        return null;
      }
      const text =
        isAssistant && containsNoResponseMarker(block.text)
          ? stripNoResponseMarkers(block.text)
          : block.text;
      if (text.length === 0) {
        return null;
      }
      const rider = (block as { _redactionVersion?: unknown })
        ._redactionVersion;
      return {
        type: "text",
        text,
        ...(typeof rider === "number" ? { _redactionVersion: rider } : {}),
      };
    }
    case "image":
    case "file": {
      const source = referenceSource(block.source);
      return source ? { type: block.type, source } : null;
    }
    case "thinking":
    case "redacted_thinking":
    case "tool_use":
    case "tool_result":
    case "server_tool_use":
    case "web_search_tool_result":
    case "ui_surface":
      return null;
    default:
      // Unreachable for a well-typed block; a stored block of a type the
      // union does not name lands here at runtime and is dropped.
      block satisfies never;
      return null;
  }
}

/**
 * The blocks of a stored row that a contact may read, in order. Only user and
 * assistant rows are read at all. A row that is internal scaffolding,
 * restricted to another reader, or whose metadata cannot be read projects to
 * nothing. So do a deliberate silence and a reaction, whose only content is a
 * stored sentinel, and a message deleted on its channel, whose row keeps the
 * original only for audit.
 *
 * Reasoning is dropped on every row, whether or not it carries the `private`
 * marker. That marker only decides whether the model's plain text was a
 * scratchpad: on a marked row the plain text is dropped and each delivered
 * `send_user_message` call becomes the text the contact reads, exactly as the
 * guardian sees it.
 */
export function projectRowForContact(
  row: StoredRowForContact,
  reader: ContactReader,
): ContactVisibleBlock[] {
  if (row.role !== "user" && row.role !== "assistant") {
    return [];
  }
  const metadata = metadataRecord(row.metadata);
  if (metadata === null) {
    return [];
  }
  const metadataJson =
    typeof row.metadata === "string" ? row.metadata : JSON.stringify(metadata);
  if (
    isEchoSuppressedUserMessage(metadata) ||
    isNoResponseMetadata(metadata) ||
    isReactionRow(metadata, metadataJson) ||
    readChannelDeletedAt(metadataJson) !== undefined ||
    !audienceAdmits(metadata, reader)
  ) {
    return [];
  }
  const content = projectUserFacingContent(row.content, {
    toolGated: isPrivateAssistantText(metadata),
  });
  const visible: ContactVisibleBlock[] = [];
  for (const block of content) {
    if (!isPlainObject(block)) {
      continue;
    }
    const projected = contactVisibleBlock(block, row.role === "assistant");
    if (projected) {
      visible.push(projected);
    }
  }
  return visible;
}
