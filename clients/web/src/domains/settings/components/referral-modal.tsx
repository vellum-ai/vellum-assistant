import { useTranslation } from "@/i18n";
import { Modal } from "@vellumai/design-library/components/modal";

import { ReferralContent } from "./referral-content";

interface ReferralModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReferralModal({ open, onOpenChange }: ReferralModalProps) {
  const { t } = useTranslation("settings");

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content data-testid="referral-modal">
        <Modal.Header>
          <Modal.Title>{t("referralModal.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ReferralContent />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
