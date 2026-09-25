import { Mail } from "lucide-react";

import { Modal } from "@vellumai/design-library";

import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";
import { useTranslation } from "@/i18n";

export interface EmailSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The platform assistant id the email routes take. */
  assistantId: string;
  assistantHandle: string | undefined;
  emailRootDomain: string;
}

/**
 * The managed email settings from the Channels page, in a modal the inbox
 * opens from its masthead: the address with its domain's verification, the
 * way to remove it, the repair notice when the domain is not yet set up
 * with the provider, and the day's usage. One body serves both doors so
 * the two never disagree about what the address is.
 */
export function EmailSettingsModal({
  open,
  onOpenChange,
  assistantId,
  assistantHandle,
  emailRootDomain,
}: EmailSettingsModalProps) {
  const { t } = useTranslation("channels");
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="md">
        <Modal.Header icon={Mail}>
          <Modal.Title>{t("emailSettingsModal.title")}</Modal.Title>
          <Modal.Description>
            {t("emailSettingsModal.description")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <EmailManagedContent
            assistantId={assistantId}
            assistantHandle={assistantHandle}
            emailRootDomain={emailRootDomain}
          />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
