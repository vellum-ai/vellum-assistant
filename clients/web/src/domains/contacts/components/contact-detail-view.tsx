import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";

import { DetailCard } from "@/components/detail-card";
import { ContactChannelsSection } from "@/domains/contacts/components/contact-channels-section";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import type { ChannelProvenanceMap } from "@/domains/contacts/hooks/use-channel-provenance";
import type { ChannelInfo, ContactPayload } from "@/domains/contacts/types";

interface ContactDetailViewProps {
  contact: ContactPayload;
  savePending: boolean;
  deletePending: boolean;
  verifyPending?: boolean;
  mergePending?: boolean;
  canMerge?: boolean;
  availableChannels?: ChannelInfo[];
  a2aEnabled?: boolean;
  channelProvenance?: ChannelProvenanceMap;
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
  channelProvenance,
  onSave,
  onDelete,
  onMerge,
  onSetupChannel,
  onVerifyChannel,
  onRevokeChannel,
  onLinkAccount,
}: ContactDetailViewProps) {
  const isNewContactDraft = contact.displayName === "New Contact";
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

  const headerName = trimmedName || contact.displayName;
  const interactionLabel = `${contact.interactionCount} interaction${contact.interactionCount === 1 ? "" : "s"}`;

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
            label="Name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Give this human a name"
            autoFocus={isNewContactDraft}
            disabled={savePending || deletePending}
            fullWidth
          />

          <Input
            label="Notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes about the human which AI will take into account"
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
              {savePending ? "Saving…" : "Save"}
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
                    ? "No other contacts available to merge"
                    : isEmptyDraft
                      ? "Save this contact before merging"
                      : dirty
                        ? "Save your changes before merging"
                        : undefined
                }
              >
                {mergePending ? "Merging…" : "Merge…"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="danger"
              onClick={requestDelete}
              disabled={deletePending}
            >
              {deletePending ? "Deleting…" : "Delete Contact"}
            </Button>
          </div>
        </div>
      </DetailCard>

      <DetailCard
        title="Linked accounts"
        subtitle="Where the assistant recognizes this contact. Link accounts you know, invite the ones you don't."
      >
        <ContactChannelsSection
          contactChannels={contact.channels}
          availableChannels={availableChannels}
          a2aEnabled={a2aEnabled}
          channelProvenance={channelProvenance}
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
        title={`Delete ${contact.displayName}?`}
        message="This will permanently delete this contact and all their channels. This action cannot be undone."
        confirmLabel="Delete"
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
