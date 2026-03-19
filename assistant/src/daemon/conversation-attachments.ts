import {
  AttachmentUploadError,
  getFilePathForAttachment,
  linkAttachmentToMessage,
  MAX_UPLOAD_BYTES,
  setAttachmentThumbnail,
  uploadAttachment,
  uploadFileBackedAttachment,
  writeAttachmentToDisk,
} from "../memory/attachments-store.js";
import {
  check,
  classifyRisk,
  generateAllowlistOptions,
  generateScopeOptions,
} from "../permissions/checker.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { addRule } from "../permissions/trust-store.js";
import { isAllowDecision } from "../permissions/types.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  type ApproveHostRead,
  type AssistantAttachmentDraft,
  contentBlocksToDrafts,
  deduplicateDrafts,
  type DirectiveRequest,
  resolveDirectives,
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
  const decision = await check(toolName, input, workingDir);

  if (decision.decision === "allow") {
    return true;
  }
  if (decision.decision === "deny") {
    return false;
  }

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
    await classifyRisk(toolName, input, workingDir),
    await generateAllowlistOptions(toolName, input),
    generateScopeOptions(workingDir, toolName),
    undefined,
    undefined,
    conversationId,
    "host",
  );

  if (
    (response.decision === "always_allow" ||
      response.decision === "always_allow_high_risk") &&
    response.selectedPattern &&
    response.selectedScope
  ) {
    addRule(
      toolName,
      response.selectedPattern,
      response.selectedScope,
      "allow",
      100,
      response.decision === "always_allow_high_risk"
        ? { allowHighRisk: true }
        : undefined,
    );
  }
  if (
    response.decision === "always_deny" &&
    response.selectedPattern &&
    response.selectedScope
  ) {
    addRule(toolName, response.selectedPattern, response.selectedScope, "deny");
  }

  return isAllowDecision(response.decision);
}

export function formatAttachmentWarnings(warnings: string[]): string | null {
  if (warnings.length === 0) return null;
  const lines = warnings.map((warning) => `Attachment warning: ${warning}`);
  return `\n\n${lines.join("\n")}`;
}

export interface AttachmentResolutionResult {
  assistantAttachments: AssistantAttachmentDraft[];
  emittedAttachments: UserMessageAttachment[];
  directiveWarnings: string[];
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
): Promise<AttachmentResolutionResult> {
  let assistantAttachments: AssistantAttachmentDraft[] = [];
  const emittedAttachments: UserMessageAttachment[] = [];

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
    accumulatedToolContentBlocks.length > 0
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

    const toolDrafts = contentBlocksToDrafts(
      accumulatedToolContentBlocks,
      toolContentBlockToolNames,
    );
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
        // uploadAttachment always writes to disk now. For oversized files
        // that exceed the upload limit, use the file-backed path which
        // bypasses the size check.
        if (draft.sizeBytes > MAX_UPLOAD_BYTES) {
          const diskFilePath = writeAttachmentToDisk(
            draft.dataBase64,
            draft.filename,
          );
          stored = uploadFileBackedAttachment(
            draft.filename,
            draft.mimeType,
            diskFilePath,
            draft.sizeBytes,
          );
        } else {
          stored = uploadAttachment(
            draft.filename,
            draft.mimeType,
            draft.dataBase64,
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
      linkAttachmentToMessage(lastAssistantMessageId, stored.id, i);
      const isVideo = draft.mimeType.startsWith("video/");
      // All attachments are file-backed; omit large data from the event payload
      const omitData = draft.dataBase64.length > MAX_INLINE_B64_SIZE;

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

      emittedAttachments.push({
        id: stored.id,
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: omitData ? "" : draft.dataBase64,
        ...(omitData ? { sizeBytes: draft.sizeBytes } : {}),
        fileBacked: true,
        ...(thumbnailData ? { thumbnailData } : {}),
      });
    }
  } else if (assistantAttachments.length > 0) {
    for (const draft of assistantAttachments) {
      emittedAttachments.push({
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: draft.dataBase64,
      });
    }
  }

  return { assistantAttachments, emittedAttachments, directiveWarnings };
}
