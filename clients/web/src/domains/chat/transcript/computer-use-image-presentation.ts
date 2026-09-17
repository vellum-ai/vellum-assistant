import { isComputerUseToolCall } from "@vellumai/assistant-api";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  projectToolResultImages,
  resolveToolResultImages,
  type ToolResultImage,
} from "@/domains/chat/components/chat-attachments/tool-result-images";
import type { DisplayAttachment } from "@/types/attachment-types";

const EMPTY_IMAGE_NAMES: ReadonlySet<string> = new Set();

export interface TranscriptImagePresentation {
  imagesByToolCallId: ReadonlyMap<string, ToolResultImage[]>;
  selectedComputerUseImage?: ToolResultImage;
  visibleAttachments: DisplayAttachment[];
}

/**
 * Selects the tool-result images and assistant attachment strip shown for one
 * message. Ordinary tool images keep their existing suppression rules, while
 * computer use contributes only the final screenshot-bearing call.
 */
export function deriveTranscriptImagePresentation(
  orderedToolCalls: readonly ChatMessageToolCall[],
  messageAttachments: readonly DisplayAttachment[] | undefined,
  embeddedImageNames: ReadonlySet<string> = EMPTY_IMAGE_NAMES,
): TranscriptImagePresentation {
  const toolCalls = [...orderedToolCalls];
  const rawImages = projectToolResultImages(toolCalls);
  const computerUseToolCallIds = new Set(
    toolCalls
      .filter((toolCall) =>
        isComputerUseToolCall(toolCall.name, toolCall.input),
      )
      .map((toolCall) => toolCall.id),
  );

  const rawImagesByToolCallId = new Map<string, ToolResultImage[]>();
  for (const image of rawImages) {
    const images = rawImagesByToolCallId.get(image.toolCallId);
    if (images) {
      images.push(image);
    } else {
      rawImagesByToolCallId.set(image.toolCallId, [image]);
    }
  }

  let selectedComputerUseImage: ToolResultImage | undefined;
  for (const toolCall of toolCalls) {
    if (!computerUseToolCallIds.has(toolCall.id)) {
      continue;
    }
    const images = rawImagesByToolCallId.get(toolCall.id);
    if (images?.length) {
      selectedComputerUseImage = images.at(-1);
    }
  }

  const ordinaryImagesByToolCallId = new Map<string, ToolResultImage[]>();
  for (const image of resolveToolResultImages(
    toolCalls,
    messageAttachments,
    embeddedImageNames,
  )) {
    if (computerUseToolCallIds.has(image.toolCallId)) {
      continue;
    }
    const images = ordinaryImagesByToolCallId.get(image.toolCallId);
    if (images) {
      images.push(image);
    } else {
      ordinaryImagesByToolCallId.set(image.toolCallId, [image]);
    }
  }

  const imagesByToolCallId = new Map<string, ToolResultImage[]>();
  for (const toolCall of toolCalls) {
    const ordinaryImages = ordinaryImagesByToolCallId.get(toolCall.id);
    if (ordinaryImages?.length) {
      imagesByToolCallId.set(toolCall.id, ordinaryImages);
    }
    if (selectedComputerUseImage?.toolCallId === toolCall.id) {
      imagesByToolCallId.set(toolCall.id, [selectedComputerUseImage]);
    }
  }

  const attachments = messageAttachments ?? [];
  const visibleAttachments = selectedComputerUseImage
    ? attachments.filter(
        (attachment) => attachment.computerUseScreenshot !== true,
      )
    : [...attachments];

  return {
    imagesByToolCallId,
    selectedComputerUseImage,
    visibleAttachments,
  };
}
