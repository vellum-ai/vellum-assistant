import { UpdateWindowPolicy } from "@/domains/settings/components/update-window-policy";
import { useTranslation } from "@/i18n";
import { Modal } from "@vellumai/design-library/components/modal";

export interface UpdateWindowModalProps {
  assistantId: string;
  open: boolean;
  onClose: () => void;
}

/** Update-window policy editor, opened from the Version card. */
export function UpdateWindowModal({
  assistantId,
  open,
  onClose,
}: UpdateWindowModalProps) {
  const { t } = useTranslation("settings");

  return (
    <Modal.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title>{t("updateWindowModal.title")}</Modal.Title>
          <Modal.Description>
            {t("updateWindowModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <UpdateWindowPolicy assistantId={assistantId} />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
