
import { CheckCircle, Loader2, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Card, Input, Typography } from "@vellumai/design-library";

export interface ContactPromptCardProps {
  contactRequest: {
    requestId: string;
    channel?: string;
    placeholder?: string;
    label?: string;
    description?: string;
    role?: string;
  };
  isSubmitting: boolean;
  accepted: boolean;
  onSubmit: (address: string, channelType: string) => void;
  onCancel: () => void;
}

export function ContactPromptCard({
  contactRequest,
  isSubmitting,
  accepted,
  onSubmit,
  onCancel,
}: ContactPromptCardProps) {
  const [address, setAddress] = useState("");
  const canSubmit = address.trim().length > 0 && !isSubmitting && !accepted;

  // Derive a sensible channelType from the hint (free text → normalised key).
  const channelType = contactRequest.channel?.toLowerCase().trim() || "email";

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(address.trim(), channelType);
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Typography variant="label-small-default" className="text-[var(--content-primary)]">
            {contactRequest.label ?? "Add a contact"}
          </Typography>
          {contactRequest.description && (
            <Typography variant="body-small-default" className="text-[var(--content-secondary)]">
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
            aria-label="Dismiss"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {accepted ? (
        // typography: off-scale — inline status badge, not prose
         
        <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
          <CheckCircle size={16} />
          Contact saved
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={contactRequest.placeholder ?? `Enter ${channelType} address`}
            disabled={isSubmitting}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              // typography: off-scale — inline form button, not prose
               
              className="rounded px-3 py-1.5 text-sm text-[var(--content-secondary)] hover:bg-[var(--surface-secondary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              // typography: off-scale — inline form button, not prose
               
              className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
