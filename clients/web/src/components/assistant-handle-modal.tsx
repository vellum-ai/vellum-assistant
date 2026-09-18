import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";

import { Modal } from "@vellumai/design-library";

import { AssistantHandleSection } from "@/components/profile-card";
import {
  assistantsListOptions,
  assistantsListQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";

export interface AssistantHandleModalProps {
  /** The assistant as the platform lists it; its id is the platform's. */
  assistant: Assistant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The assistant's handle, editable in a modal. The body is the profile
 * card's own editor, so the probe, the save, and the read-only state a
 * registered subdomain puts the handle in are the ones Settings has, and a
 * handle changed here or there is changed the same way. A save refreshes the
 * assistant listing, where every surface reads the handle from, and closes
 * the modal; the editor's toast says it went through.
 */
export function AssistantHandleModal({
  assistant,
  open,
  onOpenChange,
}: AssistantHandleModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>{t("assistantHandleModal.title")}</Modal.Title>
          {/* The stock description is the small, medium-weight line, set
              tight; two lines of it under a title read as a caption. Body
              text at its normal leading reads as the sentence it is. */}
          <Modal.Description className="mt-1.5 text-body-medium-lighter leading-normal text-[var(--content-secondary)]">
            {t("assistantHandleModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <AssistantHandleSection
            layout="modal"
            assistant={assistant}
            onSaved={() => {
              void queryClient.invalidateQueries({
                queryKey: assistantsListQueryKey(),
              });
              onOpenChange(false);
            }}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

export interface AssistantHandleModalControl {
  /** The assistant's current handle; `null` when there is none to show. */
  handle: string | null;
  /** Opens the modal; `null` when the handle is not this user's to edit here. */
  openModal: (() => void) | null;
  /** Mount once, anywhere in the caller's tree. */
  modal: ReactNode;
}

/**
 * Everything a surface needs to offer the handle modal for the active
 * assistant: the handle to show, the opener, and the modal to mount. Handles
 * live on the platform, so off a platform-hosted assistant, or before the
 * platform's listing has the assistant, there is nothing to open and
 * `openModal` is `null`; callers drop their trigger on that.
 */
export function useAssistantHandleModal(
  assistantId: string | null,
): AssistantHandleModalControl {
  const [open, setOpen] = useState(false);
  const gate = usePlatformGate({ platformHostedOnly: true });
  const onPlatform = gate === "full" && !!assistantId;
  const orgReady = useIsOrgReady();
  const { platformAssistantId } = usePlatformAssistantId(
    assistantId,
    onPlatform,
  );
  const assistantsQuery = useQuery({
    ...assistantsListOptions(),
    enabled: onPlatform && orgReady,
  });
  const assistant =
    assistantsQuery.data?.results?.find(
      (candidate) => candidate.id === platformAssistantId,
    ) ?? null;

  const openModal = useCallback(() => setOpen(true), []);

  return {
    handle: assistant?.handle || null,
    openModal: assistant ? openModal : null,
    modal: assistant ? (
      <AssistantHandleModal
        assistant={assistant}
        open={open}
        onOpenChange={setOpen}
      />
    ) : null,
  };
}
