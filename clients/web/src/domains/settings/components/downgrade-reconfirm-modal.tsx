import { AlertTriangle } from "lucide-react";

import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

export interface DowngradeReconfirmModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
  lostFeatures: string[];
}

export function DowngradeReconfirmModal({
  open,
  onCancel,
  onConfirm,
  confirming,
  lostFeatures,
}: DowngradeReconfirmModalProps) {
  const { t } = useTranslation("settings");

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !confirming) {
          onCancel();
        }
      }}
    >
      <Modal.Content size="md" hideCloseButton>
        <Modal.Header icon={AlertTriangle}>
          <Modal.Title>{t("downgradeReconfirmModal.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Typography
            as="p"
            variant="body-medium-default"
            className="text-(--content-secondary)"
          >
            {t("downgradeReconfirmModal.body")}
          </Typography>
          <ul className="mt-4 list-disc space-y-2 pl-5">
            {lostFeatures.map((feature) => (
              <li key={feature}>
                <Typography as="span" variant="body-medium-default">
                  {feature}
                </Typography>
              </li>
            ))}
          </ul>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onCancel} disabled={confirming}>
            {t("downgradeReconfirmModal.keepPro")}
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={confirming}
            data-testid="confirm-downgrade-button"
          >
            {t("downgradeReconfirmModal.confirm")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
