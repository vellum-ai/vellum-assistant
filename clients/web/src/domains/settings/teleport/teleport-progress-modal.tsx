/**
 * The modal that fronts a running teleport. It stays up from the moment the
 * transfer starts until the user either confirms the switch to the new
 * assistant or cancels back to the current one, so the two screens share one
 * dialog rather than closing and reopening between phases:
 *
 *   - transferring: the assistant's avatar over a progress bar and the
 *     current step, with no way to dismiss (closing mid-transfer would orphan
 *     the half-built target);
 *   - verifying: the completed screen with Confirm & Switch and Cancel.
 */

import { CircleCheck } from "lucide-react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useActiveAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { ProgressBar } from "@vellumai/design-library/components/progress-bar";

import type { TeleportPhase } from "./teleport-types";

const AVATAR_SIZE = 120;

interface TeleportProgressModalProps {
  phase: TeleportPhase;
  onConfirmAndSwitch: () => void;
  onCancel: () => void;
}

export function TeleportProgressModal({
  phase,
  onConfirmAndSwitch,
  onCancel,
}: TeleportProgressModalProps) {
  const { t } = useTranslation("settings");
  const open = phase.kind === "transferring" || phase.kind === "verifying";

  return (
    <Modal.Root open={open}>
      <Modal.Content
        size="sm"
        hideCloseButton
        dismissOnOverlayClick={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="items-center gap-3 p-6 text-center"
      >
        {phase.kind === "transferring" ? (
          <>
            <Modal.Title className="[&>span]:whitespace-normal">
              {t("teleportCard.transferringTitle")}
            </Modal.Title>
            <Modal.Description>{phase.step}</Modal.Description>
            <TeleportingAvatar />
            <ProgressBar
              value={phase.progress}
              aria-label={t("teleportCard.progressAriaLabel")}
              className="w-full max-w-[240px] bg-[var(--surface-active)]"
            />
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {t("teleportCard.transferringNote")}
            </p>
          </>
        ) : phase.kind === "verifying" ? (
          <>
            <CircleCheck
              className="size-10 text-[var(--system-positive-strong)]"
              aria-hidden="true"
            />
            <Modal.Title className="[&>span]:whitespace-normal">
              {t("teleportCard.verifyTitle")}
            </Modal.Title>
            <Modal.Description>
              {t("teleportCard.verifyMessage")}
            </Modal.Description>
            <div className="flex gap-2 pt-3">
              <Button variant="outlined" onClick={onCancel}>
                {t("teleportCard.cancel")}
              </Button>
              <Button variant="primary" onClick={onConfirmAndSwitch}>
                {t("teleportCard.confirmAndSwitch")}
              </Button>
            </div>
          </>
        ) : null}
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The assistant being moved, drawn busy so the character morphs while the
 * transfer runs. Holds its square until the avatar query settles so the
 * dialog does not reflow when the creature appears.
 */
function TeleportingAvatar() {
  const { ready, components, traits, customImageUrl } =
    useActiveAssistantAvatar();

  return (
    <div
      aria-hidden
      className="flex items-center justify-center py-2"
      style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
    >
      {ready ? (
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={AVATAR_SIZE}
          isAssistantBusy
        />
      ) : null}
    </div>
  );
}
