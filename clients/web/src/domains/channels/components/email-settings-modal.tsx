import { Mail } from "lucide-react";

import { Modal } from "@vellumai/design-library";

import { ChannelTrustFloorSection } from "@/domains/channels/components/channel-trust-floor-section";
import { EmailManagedContent } from "@/domains/channels/components/email-managed-content";
import { useChannelTrustFloors } from "@/domains/channels/hooks/use-channel-trust-floors";
import { useTranslation } from "@/i18n";

export interface EmailSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The platform assistant id the email routes take. */
  assistantId: string;
  /** The local assistant id the gateway's channel policy routes take. */
  localAssistantId: string;
  assistantName: string;
  assistantHandle: string | undefined;
  emailRootDomain: string;
}

/**
 * The managed email settings from the Channels page, in a modal the inbox
 * opens from its masthead: the address with its domain's verification, the
 * way to remove it, the repair notice when the domain is not yet set up
 * with the provider, and the day's usage; then who can message the
 * assistant over email, the trust floor the Channels page draws under the
 * same section. One body serves both doors so the two never disagree.
 */
export function EmailSettingsModal({
  open,
  onOpenChange,
  assistantId,
  localAssistantId,
  assistantName,
  assistantHandle,
  emailRootDomain,
}: EmailSettingsModalProps) {
  const { t } = useTranslation("channels");
  const floors = useChannelTrustFloors(localAssistantId);
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
          <div className="flex flex-col gap-5">
            <EmailManagedContent
              assistantId={assistantId}
              assistantHandle={assistantHandle}
              emailRootDomain={emailRootDomain}
            />
            {floors.onChange ? (
              <div className="border-t border-[var(--border-subtle)] pt-5">
                <ChannelTrustFloorSection
                  assistantDisplayName={assistantName}
                  policy={floors.policies?.email}
                  saving={floors.savingKey === "email"}
                  loading={floors.isLoading}
                  error={floors.isError}
                  onChange={(policy) => floors.onChange?.("email", policy)}
                />
              </div>
            ) : null}
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
