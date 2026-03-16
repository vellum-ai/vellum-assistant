import { getConfig } from "../../../../config/loader.js";
import {
  type AttachmentContext,
  isAttachmentVisible,
} from "../../../../daemon/media-visibility-policy.js";
import {
  generateImage,
  type ImageGenCredentials,
  mapGeminiError,
} from "../../../../media/gemini-image-service.js";
import {
  getAttachmentContent,
  getAttachmentsByIds,
} from "../../../../memory/attachments-store.js";
import { getConversationType } from "../../../../memory/conversation-crud.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../../../../providers/managed-proxy/context.js";
import type { ImageContent } from "../../../../providers/types.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";
import { getAttachmentSourceConversations } from "../../../../tools/assets/search.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * Check whether an attachment is visible from the given context.
 * Mirrors the logic in tools/assets/search.ts:isAttachmentVisibleFromContext.
 */
function isAttachmentAccessible(
  attachmentId: string,
  currentContext: AttachmentContext,
): boolean {
  const sources = getAttachmentSourceConversations(attachmentId);
  if (sources.length === 0) {
    return true; // orphan attachments are universally visible
  }
  const hasStandard = sources.some((s) => s.conversationType !== "private");
  if (hasStandard) {
    return true;
  }
  // All sources are private — visible only if the caller is in one of those conversations
  return sources.some((s) =>
    isAttachmentVisible(
      { conversationId: s.conversationId, isPrivate: true },
      currentContext,
    ),
  );
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const config = getConfig();
  const apiKey =
    (await getSecureKeyAsync("gemini")) ?? process.env.GEMINI_API_KEY;

  // Resolve credentials: prefer direct API key, fall back to managed proxy
  let credentials: ImageGenCredentials | undefined;
  if (apiKey) {
    credentials = { type: "direct", apiKey };
  } else {
    const managedBaseUrl = await buildManagedBaseUrl("vertex");
    if (managedBaseUrl) {
      const ctx = await resolveManagedProxyContext();
      credentials = {
        type: "managed-proxy",
        assistantApiKey: ctx.assistantApiKey,
        baseUrl: managedBaseUrl,
      };
    }
  }

  if (!credentials) {
    return {
      content:
        "No Gemini API key configured. Please set your Gemini API key to use image generation.",
      isError: true,
    };
  }

  const prompt = input.prompt as string;
  const mode = (input.mode as "generate" | "edit") ?? "generate";
  const attachmentIds = input.attachment_ids as string[] | undefined;
  const model =
    (input.model as string | undefined) ??
    config.services["image-generation"].model;
  const variants = input.variants as number | undefined;

  // Resolve source images from attachments for edit mode
  let sourceImages: Array<{ mimeType: string; dataBase64: string }> | undefined;

  if (attachmentIds && attachmentIds.length > 0) {
    const attachments = getAttachmentsByIds(attachmentIds);

    // Build visibility context for the current conversation
    const conversationType = getConversationType(context.conversationId);
    const currentContext: AttachmentContext = {
      conversationId: context.conversationId,
      isPrivate: conversationType === "private",
    };

    // Filter to only visible attachments using their originating context
    const visibleAttachments = attachments.filter((att) =>
      isAttachmentAccessible(att.id, currentContext),
    );

    if (visibleAttachments.length === 0 && attachmentIds.length > 0) {
      return {
        content:
          "None of the specified attachments could be found or are accessible.",
        isError: true,
      };
    }

    sourceImages = visibleAttachments
      .map((att) => {
        let buffer: Buffer | null | undefined;
        try {
          buffer = getAttachmentContent(att.id);
        } catch {
          // File-backed attachment may point to a missing or unreadable file
          return undefined;
        }
        if (!buffer) return undefined;
        return {
          mimeType: att.mimeType,
          dataBase64: buffer.toString("base64"),
        };
      })
      .filter((img): img is NonNullable<typeof img> => img !== undefined);
  }

  try {
    const result = await generateImage(credentials, {
      prompt,
      mode,
      sourceImages,
      model,
      variants,
    });

    const imageCount = result.images.length;
    let content = `Generated ${imageCount} image${imageCount !== 1 ? "s" : ""} using ${result.resolvedModel}.`;
    if (result.text) {
      content += `\n\n${result.text}`;
    }

    const contentBlocks: ImageContent[] = result.images.map((img) => {
      const block: ImageContent = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mimeType,
          data: img.dataBase64,
        },
      };
      if (img.title) {
        (block as unknown as Record<string, unknown>)._title = img.title;
      }
      return block;
    });

    return {
      content,
      isError: false,
      contentBlocks,
    };
  } catch (error) {
    return {
      content: mapGeminiError(error),
      isError: true,
    };
  }
}
