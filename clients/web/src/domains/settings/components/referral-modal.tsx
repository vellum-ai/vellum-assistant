import { Modal } from "@vellumai/design-library/components/modal";

import { ReferralContent } from "./referral-content";

interface ReferralModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReferralModal({ open, onOpenChange }: ReferralModalProps) {
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content data-testid="referral-modal">
        <Modal.Header>
          <Modal.Title>Earn Free Credits</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ReferralContent />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
