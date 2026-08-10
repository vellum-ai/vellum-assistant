import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

import { DetailCard } from "@/components/detail-card";
import { ContactChannelsSection } from "@/domains/contacts/components/contact-channels-section";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import { ShareConnectionLinkButton } from "@/components/share-connection-link-button";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";
import { useTranslation } from "@/i18n";

interface GuardianDetailViewProps {
  contact: ContactPayload;
  savePending: boolean;
  verifyPending?: boolean;
  mergePending?: boolean;
  canMerge?: boolean;
  availableChannels?: ChannelInfo[];
  a2aEnabled?: boolean;
  onSave: (patch: { displayName: string; notes: string }) => void;
  onMerge?: () => void;
  onSetupChannel?: (type: string) => void;
  onVerifyChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
  onGenerateInviteLink?: () => void;
}

export function GuardianDetailView(props: GuardianDetailViewProps) {
  return <GuardianDetailViewInner key={props.contact.id} {...props} />;
}

function GuardianDetailViewInner({
  contact,
  savePending,
  verifyPending,
  mergePending = false,
  canMerge = false,
  availableChannels,
  a2aEnabled,
  onSave,
  onMerge,
  onSetupChannel,
  onVerifyChannel,
  onRevokeChannel,
  onGenerateInviteLink,
}: GuardianDetailViewProps) {
  const { t } = useTranslation("contacts");
  const principalId = contact.displayName.startsWith("vellum-principal-");
  const initialName = principalId ? "" : contact.displayName;
  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState(contact.notes ?? "");

  const trimmedName = name.trim();
  const trimmedNotes = notes.trim();
  const dirty =
    trimmedName !== initialName.trim() ||
    trimmedNotes !== (contact.notes ?? "").trim();
  const canSave = dirty && !savePending;

  // ICU `plural` picks the category through `Intl.PluralRules`, so the count
  // agrees in languages with more than the two forms English has.
  const interactionLabel = t("contact.interactions", {
    count: contact.interactionCount,
  });
  const headerName = principalId
    ? t("contactsList.you")
    : t("contactsList.youNamed", { name: contact.displayName });

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        title={headerName}
        accessory={<ContactTypeBadge role="guardian" />}
        compactAccessory
        subtitle={interactionLabel}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t("contact.nameLabel")}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("guardianDetailView.namePlaceholder")}
            disabled={savePending}
            fullWidth
          />

          <Input
            label={t("contact.notesLabel")}
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("guardianDetailView.notesPlaceholder")}
            disabled={savePending}
            fullWidth
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() =>
                onSave({
                  displayName: trimmedName || contact.displayName,
                  notes: trimmedNotes,
                })
              }
              disabled={!canSave}
            >
              {savePending ? t("actions.saving") : t("actions.save")}
            </Button>
            {onMerge ? (
              <Button
                variant="outlined"
                onClick={onMerge}
                disabled={!canMerge || dirty || mergePending || savePending}
                title={
                  !canMerge
                    ? t("contact.mergeBlockedNoCandidates")
                    : dirty
                      ? t("contact.mergeBlockedUnsaved")
                      : undefined
                }
              >
                {mergePending ? t("actions.merging") : t("actions.merge")}
              </Button>
            ) : null}
          </div>
        </div>
      </DetailCard>

      <DetailCard
        title={t("guardianDetailView.channelsTitle")}
        subtitle={t("guardianDetailView.channelsSubtitle")}
      >
        <ContactChannelsSection
          contactChannels={contact.channels}
          availableChannels={availableChannels}
          a2aEnabled={a2aEnabled}
          setupLabel={t("guardianDetailView.setupLabel")}
          verifyLoading={verifyPending}
          onSetupChannel={onSetupChannel}
          onVerifyChannel={onVerifyChannel}
          onRevokeChannel={onRevokeChannel}
        />
      </DetailCard>

      {onGenerateInviteLink ? (
        <ShareConnectionLinkButton onClick={onGenerateInviteLink} />
      ) : null}
    </div>
  );
}
