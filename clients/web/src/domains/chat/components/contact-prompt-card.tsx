import { CheckCircle, Loader2, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  Button,
  Card,
  Checkbox,
  Input,
  Typography,
} from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

export interface ContactPromptCardProps {
  contactRequest: {
    requestId: string;
    channel?: string;
    placeholder?: string;
    defaultValue?: string;
    label?: string;
    description?: string;
    role?: string;
    verify?: boolean;
  };
  isSubmitting: boolean;
  accepted: boolean;
  onSubmit: (address: string, channelType: string, verify: boolean) => void;
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
  const canSubmit = address.trim().length > 0 && !isSubmitting && !accepted;

  // Derive a sensible channelType from the hint (free text → normalised key).
  const channelType = contactRequest.channel?.toLowerCase().trim() || "email";

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSubmit(address.trim(), channelType, verify);
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Typography
            variant="label-small-default"
            className="text-[var(--content-primary)]"
          >
            {contactRequest.label ?? t("contactPromptCard.addContact")}
          </Typography>
          {contactRequest.description && (
            <Typography
              variant="body-small-default"
              className="text-[var(--content-secondary)]"
            >
              {contactRequest.description}
            </Typography>
          )}
        </div>
        {!accepted && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="shrink-0 text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
            aria-label={t("contactPromptCard.dismiss")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {accepted ? (
        // typography: off-scale — inline status badge, not prose

        <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
          <CheckCircle size={16} />
          {t("contactPromptCard.contactSaved")}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={
              contactRequest.placeholder ??
              t("contactPromptCard.enterAddress", { channel: channelType })
            }
            disabled={isSubmitting}
            autoFocus
          />
          <Checkbox
            checked={verify}
            onCheckedChange={(next) => setVerify(next === true)}
            disabled={isSubmitting}
            label={t("contactPromptCard.markVerified")}
            helperText={t("contactPromptCard.markVerifiedHelp")}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
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
    </Card>
  );
}
