import type { PermissionPrompter } from "../permissions/prompter.js";
import {
  attachInlineAttachmentToMessage,
  AttachmentUploadError,
  getAttachmentsByIds,
  getFilePathForAttachment,
  linkAttachmentToMessage,
  setAttachmentThumbnail,
} from "../persistence/attachments-store.js";
import { updateMessageMetadata } from "../persistence/conversation-crud.js";
import { COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY } from "../persistence/conversation-types.js";
import type { ContentBlock, ImageContent } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  type ApproveHostRead,
  type AssistantAttachmentDraft,
  type AttachmentSourceType,
  contentBlocksToDrafts,
  deduplicateDrafts,
  type DirectiveRequest,
  estimateBase64Bytes,
  resolveDirectives,
  toolImageFilename,
  validateDrafts,
} from "./assistant-attachments.js";
import type { UserMessageAttachment } from "./message-protocol.js";
import {
  generateVideoThumbnail,
  generateVideoThumbnailFromPath,
} from "./video-thumbnail.js";

const log = getLogger("conversation-attachments");

/**
 * Approve reading a host file for assistant attachment resolution.
 * Checks the permission store and prompts the user if needed.
 */
export async function approveHostAttachmentRead(
  filePath: string,
  workingDir: string,
  prompter: PermissionPrompter,
  conversationId: string,
  hasNoClient: boolean,
): Promise<boolean> {
  const toolName = "host_file_read";
  const input = { path: filePath };

  // HTTP-created sessions use a no-op sendToClient — prompting would
  // block for the full permission timeout before auto-denying.
  if (hasNoClient) {
    log.info(
      { filePath },
      "Denying host attachment read: no interactive client connected",
    );
    return false;
  }

  const response = await prompter.prompt(
    toolName,
    input,
    "low",
    [],
    [],
    undefined,
    conversationId,
    "host",
    false,
  );

  return response.decision === "allow";
}

/**
 * A file the assistant named that survived resolution, validation, and
 * persistence. Rejected directives (missing, oversized, denied) and drafts
 * whose upload was skipped never appear here, so a caller pointing a user
 * at "the files this turn produced" cannot offer a broken one.
 */
export interface PersistedAttachmentFile {
  /** Absolute path the attachment was read from. */
  sourcePath: string;
  /** Name the attachment was persisted under. */
  displayName: string;
  /**
   * Boundary the path was resolved against. A caller that surfaces the path
   * needs it: only `sandbox_file` paths are the assistant's own workspace,
   * and a `host_file` path is the user's machine.
   */
  sourceType: AttachmentSourceType;
}

export interface AttachmentResolutionResult {
  assistantAttachments: AssistantAttachmentDraft[];
  emittedAttachments: UserMessageAttachment[];
  directiveWarnings: string[];
  persistedFiles: PersistedAttachmentFile[];
  /** Attachment ids successfully linked to the target assistant row. */
  linkedAttachmentIds: string[];
  computerUseScreenshotAttachmentIds: string[];
}

export interface ComputerUseScreenshotCandidate {
  toolName: string;
  block: ImageContent;
}

interface ResolvedAttachmentDraft extends AssistantAttachmentDraft {
  existingAttachmentId?: string;
  computerUseScreenshot?: boolean;
}

/**
 * Resolve accumulated directives and tool content blocks into assistant
 * attachments. Persists attachments and links them to the assistant message.
 */
export async function resolveAssistantAttachments(
  accumulatedDirectives: DirectiveRequest[],
  accumulatedToolContentBlocks: ContentBlock[],
  directiveWarnings: string[],
  workingDir: string,
  approveHostRead: ApproveHostRead,
  lastAssistantMessageId: string | undefined,
  toolContentBlockToolNames?: ReadonlyMap<number, string>,
  computerUseScreenshotCandidate?: ComputerUseScreenshotCandidate,
): Promise<AttachmentResolutionResult> {
  let assistantAttachments: ResolvedAttachmentDraft[] = [];
  const emittedAttachments: UserMessageAttachment[] = [];
  const persistedFiles: PersistedAttachmentFile[] = [];
  const linkedAttachmentIds: string[] = [];
  const computerUseScreenshotAttachmentIds: string[] = [];

  const recordPersistedFile = (draft: AssistantAttachmentDraft): void => {
    if (draft.sourcePath) {
      persistedFiles.push({
        sourcePath: draft.sourcePath,
        displayName: draft.filename,
        sourceType: draft.sourceType,
      });
    }
  };

  log.info(
    {
      directiveCount: accumulatedDirectives.length,
      toolBlockCount: accumulatedToolContentBlocks.length,
      workingDir,
    },
    "Resolving assistant attachments",
  );

  if (
    accumulatedDirectives.length > 0 ||
    accumulatedToolContentBlocks.length > 0 ||
    computerUseScreenshotCandidate !== undefined
  ) {
    const directiveDrafts =
      accumulatedDirectives.length > 0
        ? await resolveDirectives(
            accumulatedDirectives,
            workingDir,
            approveHostRead,
          )
        : { drafts: [], warnings: [] };
    directiveWarnings.push(...directiveDrafts.warnings);

    if (directiveDrafts.warnings.length > 0) {
      log.warn(
        { warnings: directiveDrafts.warnings },
        "Directive resolution warnings",
      );
    }
    log.info(
      {
        resolvedDrafts: directiveDrafts.drafts.length,
        directives: accumulatedDirectives.map((d) => ({
          source: d.source,
          path: d.path,
          filename: d.filename,
          mimeType: d.mimeType,
        })),
      },
      "Directive resolution complete",
    );

    const toolDrafts: ResolvedAttachmentDraft[] = contentBlocksToDrafts(
      accumulatedToolContentBlocks,
      toolContentBlockToolNames,
    );
    if (computerUseScreenshotCandidate) {
      const { block, toolName } = computerUseScreenshotCandidate;
      const filename =
        block.source.filename ??
        toolImageFilename(block.source.media_type, toolName);
      if (block.source.type === "workspace_ref") {
        const stored = getAttachmentsByIds([block.source.attachmentId], {
          hydrateFileData: true,
        })[0];
        if (stored?.dataBase64) {
          toolDrafts.push({
            sourceType: "tool_block",
            filename,
            mimeType: stored.mimeType,
            dataBase64: stored.dataBase64,
            sizeBytes: stored.sizeBytes,
            kind: "image",
            existingAttachmentId: stored.id,
            computerUseScreenshot: true,
          });
        }
      } else {
        toolDrafts.push({
          sourceType: "tool_block",
          filename,
          mimeType: block.source.media_type,
          dataBase64: block.source.data,
          sizeBytes: estimateBase64Bytes(block.source.data),
          kind: "image",
        });
      }
    }
    // Most recent tool outputs first so deduplication keeps the latest version.
    toolDrafts.reverse();
    const merged = deduplicateDrafts([
      ...directiveDrafts.drafts,
      ...toolDrafts,
    ]);
    const validated = validateDrafts(merged);
    directiveWarnings.push(...validated.warnings);
    assistantAttachments = validated.accepted;

    log.info(
      {
        merged: merged.length,
        accepted: validated.accepted.length,
        validationWarnings: validated.warnings,
      },
      "Attachment validation complete",
    );
  } else {
    log.info("No directives or tool content blocks to resolve");
  }

  // Persist resolved attachments and link to the last assistant message.
  // Large video attachments are omitted from the event payload and lazy-loaded
  // by the client via the HTTP endpoint (same pattern as history_response).
  const MAX_INLINE_B64_SIZE = 512 * 1024;

  if (assistantAttachments.length > 0 && lastAssistantMessageId) {
    for (let i = 0; i < assistantAttachments.length; i++) {
      const draft = assistantAttachments[i];
      let stored;
      try {
        stored = draft.existingAttachmentId
          ? getAttachmentsByIds([
              linkAttachmentToMessage(
                lastAssistantMessageId,
                draft.existingAttachmentId,
                i,
              ),
            ])[0]
          : await attachInlineAttachmentToMessage(
              lastAssistantMessageId,
              i,
              draft.filename,
              draft.mimeType,
              draft.dataBase64,
              { skipSizeLimit: true },
            );
        if (!stored) {
          throw new Error(
            `Attachment not found: ${draft.existingAttachmentId}`,
          );
        }
      } catch (err) {
        if (err instanceof AttachmentUploadError) {
          log.warn(
            { filename: draft.filename, error: err.message },
            "Skipping attachment upload",
          );
          directiveWarnings.push(
            `Attachment ${draft.filename} skipped: ${err.message}`,
          );
          continue;
        }
        throw err;
      }
      const isVideo = draft.mimeType.startsWith("video/");
      // Only omit data for videos — they have an end-to-end lazy-load path
      // via /v1/attachments/:id/content. Other types (images, PDFs) still need
      // inline data for thumbnails, preview, and file-save in the client.
      const omitData = isVideo && draft.dataBase64.length > MAX_INLINE_B64_SIZE;

      // Generate and persist a thumbnail for video attachments.
      let thumbnailData: string | undefined;
      if (isVideo) {
        const existing = stored.thumbnailBase64;
        if (existing) {
          thumbnailData = existing;
        } else {
          const diskFilePath = getFilePathForAttachment(stored.id);
          const generated = diskFilePath
            ? await generateVideoThumbnailFromPath(diskFilePath)
            : await generateVideoThumbnail(draft.dataBase64);
          if (generated) {
            setAttachmentThumbnail(stored.id, generated);
            thumbnailData = generated;
          }
        }
      }

      recordPersistedFile(draft);
      linkedAttachmentIds.push(stored.id);
      emittedAttachments.push({
        id: stored.id,
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: omitData ? "" : draft.dataBase64,
        sourceType: draft.sourceType,
        ...(omitData ? { sizeBytes: draft.sizeBytes } : {}),
        fileBacked: true,
        ...(thumbnailData ? { thumbnailData } : {}),
        ...(draft.computerUseScreenshot ? { computerUseScreenshot: true } : {}),
      });
      if (draft.computerUseScreenshot) {
        computerUseScreenshotAttachmentIds.push(stored.id);
      }
    }
    if (computerUseScreenshotAttachmentIds.length > 0) {
      updateMessageMetadata(lastAssistantMessageId, {
        [COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY]:
          computerUseScreenshotAttachmentIds,
      });
    }
  } else if (assistantAttachments.length > 0) {
    // No assistant message to attach to: the drafts are emitted to the client
    // for this turn only and nothing is stored, so none of them is a
    // persisted file.
    for (const draft of assistantAttachments) {
      emittedAttachments.push({
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: draft.dataBase64,
        sourceType: draft.sourceType,
      });
    }
  }

  return {
    assistantAttachments,
    emittedAttachments,
    directiveWarnings,
    persistedFiles,
    linkedAttachmentIds,
    computerUseScreenshotAttachmentIds,
  };
}
