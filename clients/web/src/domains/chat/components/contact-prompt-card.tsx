import { CheckCircle, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  Button,
  Card,
  Checkbox,
  Input,
  Typography,
} from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

import type { PendingContactRequestState } from "@/types/interaction-ui-types";

export interface ContactPromptCardProps {
  contactRequest: PendingContactRequestState;
  isSubmitting: boolean;
  accepted: boolean;
  onSubmit: (
    address: string,
    channelType: string,
    verify: boolean,
    displayName?: string,
  ) => void;
  onCancel: () => void;
}

export function ContactPromptCard({
  contactRequest,
  isSubmitting,
  accepted,
  onSubmit,
  onCancel,
}: ContactPromptCardProps) {
  const { t } = useTranslation("chat");
  // Render sites must key this card by `requestId` so a new contact_request
  // remounts it and re-runs this initializer instead of keeping stale state.
  const [address, setAddress] = useState(contactRequest.defaultValue ?? "");
  // The command only proposes this. What the guardian submits is what gets
  // attested, so the box has to be theirs to uncheck.
  const [verify, setVerify] = useState(contactRequest.verify === true);
  // A proposed name means this address would create a contact, so the guardian
  // gets to name it.
  const proposesName = Boolean(contactRequest.displayName);
  const [displayName, setDisplayName] = useState(
    contactRequest.displayName ?? "",
  );
  const canSubmit =
    address.trim().length > 0 &&
    (!proposesName || displayName.trim().length > 0) &&
    !isSubmitting &&
    !accepted;

  // Derive a sensible channelType from the hint (free text → normalised key).
  const channelType = contactRequest.channel?.toLowerCase().trim() || "email";

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit(
      address.trim(),
      channelType,
      verify,
      proposesName ? displayName.trim() : undefined,
    );
  }

  return (
    <Card.Root padding="md" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Typography
          variant="title-medium"
          className="text-[var(--content-emphasised)]"
        >
          {contactRequest.label ?? t("contactPromptCard.addContact")}
        </Typography>
        {contactRequest.contactDisplayName && (
          <Typography
            variant="body-medium-lighter"
            className="text-[var(--content-tertiary)]"
          >
            {t("contactPromptCard.addingToContact", {
              name: contactRequest.contactDisplayName,
            })}
          </Typography>
        )}
        {contactRequest.description && (
          <Typography
            variant="body-medium-lighter"
            className="text-[var(--content-tertiary)]"
          >
            {contactRequest.description}
          </Typography>
        )}
      </div>

      {accepted ? (
        <div className="flex items-center gap-2 text-body-medium-default text-[var(--system-positive-strong)]">
          <CheckCircle size={16} />
          {t("contactPromptCard.contactSaved")}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {proposesName && (
            <Input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("contactPromptCard.namePlaceholder")}
              disabled={isSubmitting}
              fullWidth
            />
          )}
          {/* Read only: `contacts update` is where notes are edited. */}
          {contactRequest.notes && (
            <div className="flex flex-col gap-1">
              <Typography
                variant="label-medium-default"
                className="text-[var(--content-secondary)]"
              >
                {t("contactPromptCard.notesLabel")}
              </Typography>
              <Typography
                variant="body-medium-lighter"
                className="text-[var(--content-tertiary)]"
              >
                {contactRequest.notes}
              </Typography>
            </div>
          )}
          <Input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={
              contactRequest.placeholder ??
              t("contactPromptCard.enterAddress", { channel: channelType })
            }
            disabled={isSubmitting}
            fullWidth
            autoFocus
          />
          <Checkbox
            checked={verify}
            onCheckedChange={(next) => setVerify(next === true)}
            disabled={isSubmitting}
            label={t("contactPromptCard.markVerified")}
            helperText={t("contactPromptCard.markVerifiedHelp")}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outlined"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("contactPromptCard.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!canSubmit}
              leftIcon={
                isSubmitting ? <Loader2 className="animate-spin" /> : undefined
              }
            >
              {isSubmitting
                ? t("contactPromptCard.saving")
                : t("contactPromptCard.save")}
            </Button>
          </div>
        </form>
      )}
    </Card.Root>
  );
}
