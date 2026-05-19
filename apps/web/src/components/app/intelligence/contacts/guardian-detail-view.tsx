
import { useState } from "react";

import { ContactChannelsSection } from "@/components/app/intelligence/contacts/contact-channels-section.js";
import { ContactTypeBadge } from "@/components/app/intelligence/contacts/ContactTypeBadge.js";
import { Button } from "@vellum/design-library/components/button";
import { Input, Textarea } from "@vellum/design-library/components/input";
import { SettingsCard } from "@/components/app/settings/SettingsCard.js";
import type { ChannelInfo, ContactPayload } from "@/lib/contacts/types.js";

interface GuardianDetailViewProps {
  contact: ContactPayload;
  savePending: boolean;
  verifyPending?: boolean;
  mergePending?: boolean;
  /**
   * Whether any non-guardian contact exists that could be merged into the
   * guardian (e.g. a duplicate identity captured under a contact channel).
   */
  canMerge?: boolean;
  /**
   * Channels the assistant supports, with display metadata. Sourced from
   * `/v1/channels/available`. Passed through to `ContactChannelsSection`.
   */
  availableChannels?: ChannelInfo[];
  /** Whether the A2A channel feature flag is enabled. */
  a2aEnabled?: boolean;
  onSave: (patch: { displayName: string; notes: string }) => Promise<void>;
  onMerge?: () => void;
  onSetupChannel?: (type: string) => void;
  onVerifyChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
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
}: GuardianDetailViewProps) {
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

  const interactionLabel = `${contact.interactionCount} interaction${contact.interactionCount === 1 ? "" : "s"}`;
  const headerName = principalId
    ? "You"
    : `${contact.displayName} (You)`;

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard
        title={headerName}
        accessory={<ContactTypeBadge role="guardian" />}
        compactAccessory
        subtitle={interactionLabel}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            disabled={savePending}
            fullWidth
          />

          <Textarea
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Notes about yourself which AI will take into account"
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
              {savePending ? "Saving…" : "Save"}
            </Button>
            {onMerge ? (
              <Button
                variant="outlined"
                onClick={onMerge}
                disabled={!canMerge || dirty || mergePending || savePending}
                title={
                  !canMerge
                    ? "No other contacts available to merge"
                    : dirty
                      ? "Save your changes before merging"
                      : undefined
                }
              >
                {mergePending ? "Merging…" : "Merge…"}
              </Button>
            ) : null}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Channels"
        subtitle="Once verified, your assistant will recognize you when you message from these channels."
      >
        <ContactChannelsSection
          contactChannels={contact.channels}
          availableChannels={availableChannels}
          a2aEnabled={a2aEnabled}
          setupLabel="Enable"
          verifyLoading={verifyPending}
          onSetupChannel={onSetupChannel}
          onVerifyChannel={onVerifyChannel}
          onRevokeChannel={onRevokeChannel}
        />
      </SettingsCard>
    </div>
  );
}
