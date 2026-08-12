import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";

import { DetailCard } from "@/components/detail-card";
import { ContactChannelsSection } from "@/domains/contacts/components/contact-channels-section";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import { isDraftContactName } from "@/domains/contacts/draft-contact";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";
import { useTranslation } from "@/i18n";

interface ContactDetailViewProps {
  contact: ContactPayload;
  savePending: boolean;
  deletePending: boolean;
  verifyPending?: boolean;
  mergePending?: boolean;
  canMerge?: boolean;
  availableChannels?: ChannelInfo[];
  a2aEnabled?: boolean;
  onSave: (patch: { displayName: string; notes: string }) => void;
  onDelete: () => void;
  onMerge?: () => void;
  onSetupChannel?: (type: string) => void;
  onVerifyChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
  /** Opens the roster picker for a linkable channel row. */
  onLinkAccount?: (channelId: string) => void;
}

export function ContactDetailView(props: ContactDetailViewProps) {
  return <ContactDetailViewInner key={props.contact.id} {...props} />;
}

function ContactDetailViewInner({
  contact,
  savePending,
  deletePending,
  verifyPending,
  mergePending = false,
  canMerge = false,
  availableChannels,
  a2aEnabled,
  onSave,
  onDelete,
  onMerge,
  onSetupChannel,
  onVerifyChannel,
  onRevokeChannel,
  onLinkAccount,
}: ContactDetailViewProps) {
  const { t } = useTranslation("contacts");
  const isNewContactDraft = isDraftContactName(contact.displayName);
  const [displayName, setDisplayName] = useState(
    isNewContactDraft ? "" : contact.displayName,
  );
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const trimmedName = displayName.trim();
  const trimmedNotes = notes.trim();
  const originalName = isNewContactDraft ? "" : contact.displayName;
  const originalNotes = contact.notes ?? "";
  const dirty = trimmedName !== originalName || trimmedNotes !== originalNotes;

  const canSave =
    trimmedName.length > 0 && dirty && !savePending && !deletePending;
  const isEmptyDraft =
    isNewContactDraft &&
    contact.channels.length === 0 &&
    contact.interactionCount === 0;

  const headerName =
    trimmedName || (isNewContactDraft ? t("contact.draftName") : contact.displayName);
  // ICU `plural` picks the category through `Intl.PluralRules`, so the count
  // agrees in languages with more than the two forms English has.
  const interactionLabel = t("contact.interactions", {
    count: contact.interactionCount,
  });

  const requestDelete = () => {
    if (isEmptyDraft) {
      onDelete();
    } else {
      setConfirmOpen(true);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        title={headerName}
        accessory={
          <ContactTypeBadge
            role={contact.role}
            contactType={contact.contactType}
          />
        }
        compactAccessory
        subtitle={interactionLabel}
      >
        <div className="flex flex-col gap-4">
          <Input
            label={t("contact.nameLabel")}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t("contactDetailView.namePlaceholder")}
            autoFocus={isNewContactDraft}
            disabled={savePending || deletePending}
            fullWidth
          />

          <Input
            label={t("contact.notesLabel")}
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("contactDetailView.notesPlaceholder")}
            disabled={savePending || deletePending}
            fullWidth
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() =>
                onSave({ displayName: trimmedName, notes: trimmedNotes })
              }
              disabled={!canSave}
            >
              {savePending ? t("actions.saving") : t("actions.save")}
            </Button>
            {onMerge ? (
              <Button
                type="button"
                variant="outlined"
                onClick={onMerge}
                disabled={
                  !canMerge ||
                  isEmptyDraft ||
                  dirty ||
                  mergePending ||
                  savePending ||
                  deletePending
                }
                title={
                  !canMerge
                    ? t("contact.mergeBlockedNoCandidates")
                    : isEmptyDraft
                      ? t("contactDetailView.mergeBlockedUnsavedDraft")
                      : dirty
                        ? t("contact.mergeBlockedUnsaved")
                        : undefined
                }
              >
                {mergePending ? t("actions.merging") : t("actions.merge")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="danger"
              onClick={requestDelete}
              disabled={deletePending}
            >
              {deletePending
                ? t("actions.deleting")
                : t("contactDetailView.delete")}
            </Button>
          </div>
        </div>
      </DetailCard>

      <DetailCard
        title={t("contactDetailView.linkedAccountsTitle")}
        subtitle={t("contactDetailView.linkedAccountsSubtitle")}
      >
        <ContactChannelsSection
          contactChannels={contact.channels}
          availableChannels={availableChannels}
          a2aEnabled={a2aEnabled}
          verifyLoading={verifyPending}
          verifySubject="contact"
          onSetupChannel={onSetupChannel}
          onVerifyChannel={onVerifyChannel}
          onRevokeChannel={onRevokeChannel}
          onLinkAccount={onLinkAccount}
        />
      </DetailCard>

      <ConfirmDialog
        open={confirmOpen}
        title={t("contactDetailView.deleteConfirmTitle", {
          name: headerName,
        })}
        message={t("contactDetailView.deleteConfirmMessage")}
        confirmLabel={t("actions.delete")}
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          onDelete();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
