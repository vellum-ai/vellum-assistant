import { Button, Modal } from "@vellumai/design-library";
import { Monitor } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { DesktopPanel } from "./desktop-panel";

/**
 * The header control that opens the pod desktop, and the modal it opens.
 *
 * Renders nothing unless the `pod-desktop` assistant flag is positively on
 * for the active assistant. The flag is served per assistant and defaults
 * off, so an assistant that cannot serve a desktop (no container, no X
 * server) never advertises one; the runtime's own gate is the backstop, and
 * its refusal reaches the panel as a close code it explains.
 *
 * The panel mounts only while the modal is open, which is what starts and
 * ends the session: Radix unmounts closed content, and the panel closes its
 * session on unmount.
 */
export function PodDesktopAffordance() {
  const { t } = useTranslation("chat");
  const enabled = useAssistantFeatureFlagStore.use.podDesktop();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const [open, setOpen] = useState(false);

  if (enabled !== true || assistantId === null) {
    return null;
  }

  return (
    <>
      <Button
        variant="ghost"
        iconOnly={<Monitor />}
        aria-label={t("podDesktop.openAria")}
        tooltip={t("podDesktop.openAria")}
        onClick={() => setOpen(true)}
      />
      <Modal.Root open={open} onOpenChange={setOpen}>
        <Modal.Content size="xl" className="h-[calc(100vh-2rem)]">
          <Modal.Header>
            <Modal.Title>{t("podDesktop.title")}</Modal.Title>
          </Modal.Header>
          <Modal.Body className="min-h-0 overflow-hidden p-0">
            <DesktopPanel assistantId={assistantId} />
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
