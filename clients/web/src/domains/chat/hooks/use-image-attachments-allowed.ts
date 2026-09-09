/**
 * Whether an image staged for the next message in a conversation would survive
 * the turn, read by every drop/pick filter that stages attachments.
 *
 * On an assistant with the image-fallback plugin the vision gate is inactive
 * and the question does not arise. Below it, an image on a profile without
 * vision fails the whole turn on the provider's rejection, so the surface has
 * to turn the image away before it is staged.
 *
 * `conversationId` is the conversation the message is sent to, so a surface
 * targeting a conversation other than the active one (the document composer)
 * gates on the model that conversation actually runs. `pendingProfile` carries
 * the stashed profile of a conversation whose row has not loaded yet, which is
 * the profile its first message uses.
 */
import { useActiveProfileModel } from "@/domains/chat/hooks/use-active-profile-model";
import { useVisionAttachmentGate } from "@/lib/backwards-compat/vision-attachment-gate";

export function useImageAttachmentsAllowed(
  assistantId: string | null,
  conversationId: string | undefined,
  pendingProfile?: string | null,
): boolean {
  const activeProfileModel = useActiveProfileModel(
    assistantId,
    conversationId,
    pendingProfile,
  );
  const visionGateActive = useVisionAttachmentGate();
  return !visionGateActive || (activeProfileModel?.supportsVision ?? true);
}
