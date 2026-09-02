import { Button, Modal } from "@vellumai/design-library";
import { Monitor } from "lucide-react";
import { lazy, useState } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

// The panel pulls in noVNC, which nobody should download for a default-off
// feature; the chunk loads the first time the modal opens.
const DesktopPanel = lazy(() =>
  import("./desktop-panel").then((m) => ({ default: m.DesktopPanel })),
);

/**
 * The header control that opens the pod desktop, and the modal it opens.
 * Renders nothing unless the per-assistant `pod-desktop` flag is positively
 * on, since it is off wherever no desktop exists; the runtime's own refusal
 * is the backstop. The panel mounts only while the modal is open.
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
            <LazyBoundary>
              <DesktopPanel assistantId={assistantId} />
            </LazyBoundary>
          </Modal.Body>
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
