
import { useState } from "react";

import { ContactChannelsSection } from "@/components/app/intelligence/contacts/contact-channels-section.js";
import { ContactTypeBadge } from "@/components/app/intelligence/contacts/ContactTypeBadge.js";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { Button } from "@vellum/design-library/components/button";
import { Input, Textarea } from "@vellum/design-library/components/input";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import type { ChannelInfo, ContactPayload } from "@/lib/contacts/types.js";

interface ContactDetailViewProps {
  contact: ContactPayload;
  savePending: boolean;
  deletePending: boolean;
  mergePending?: boolean;
  /**
   * Whether at least one other contact exists that could be merged into this
   * one. When `false` the Merge button is disabled with a tooltip-friendly
   * label so users understand why.
   */
  canMerge?: boolean;
  availableChannels?: ChannelInfo[];
  /** Whether the A2A channel feature flag is enabled. */
  a2aEnabled?: boolean;
  onSave: (patch: { displayName: string; notes: string }) => Promise<void>;
  onDelete: () => Promise<void>;
  onMerge?: () => void;
  onSetupChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
}

export function ContactDetailView(props: ContactDetailViewProps) {
  return <ContactDetailViewInner key={props.contact.id} {...props} />;
}

function ContactDetailViewInner({
  contact,
  savePending,
  deletePending,
  mergePending = false,
  canMerge = false,
  availableChannels,
  a2aEnabled,
  onSave,
  onDelete,
  onMerge,
  onSetupChannel,
  onRevokeChannel,
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

  const canSave = trimmedName.length > 0 && dirty && !savePending && !deletePending;
  const isEmptyDraft =
    isNewContactDraft &&
    contact.channels.length === 0 &&
    contact.interactionCount === 0;

  const headerName = trimmedName || contact.displayName;
  const interactionLabel = `${contact.interactionCount} interaction${contact.interactionCount === 1 ? "" : "s"}`;

  const requestDelete = () => {
    if (isEmptyDraft) {
      void onDelete();
    } else {
      setConfirmOpen(true);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        title={headerName}
        accessory={<ContactTypeBadge role={contact.role} contactType={contact.contactType} />}
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

          <Textarea
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
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
      </SettingsCard>

      <SettingsCard
        title="Channels"
        subtitle="Once verified, your assistant will recognize this contact when they message from these channels."
      >
        <ContactChannelsSection
          contactChannels={contact.channels}
          availableChannels={availableChannels}
          a2aEnabled={a2aEnabled}
          onSetupChannel={onSetupChannel}
          onRevokeChannel={onRevokeChannel}
        />
      </SettingsCard>

      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${contact.displayName}?`}
        message="This will permanently delete this contact and all their channels. This action cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          setConfirmOpen(false);
          await onDelete();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
