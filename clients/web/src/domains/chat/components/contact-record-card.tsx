/**
 * The guardian's answer to a contact record write the assistant proposed.
 *
 * Create and update show an editable form seeded with the proposal, so the
 * guardian confirms values they can change rather than rubber-stamping the
 * assistant's. Delete shows what is about to be lost and asks only for a
 * confirmation. Nothing is written until this card is submitted.
 */

import { CheckCircle, Loader2, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import {
  Button,
  Card,
  Input,
  Textarea,
  Typography,
} from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

import type { PendingContactRecordRequestState } from "@/types/interaction-ui-types";

export interface ContactRecordCardProps {
  request: PendingContactRecordRequestState;
  isSubmitting: boolean;
  accepted: boolean;
  /**
   * Only the fields the guardian actually changed. What they left alone is
   * omitted rather than echoed back, so a value another client edited in the
   * meantime is preserved instead of overwritten with this form's snapshot.
   */
  onSubmit: (values: { displayName?: string; notes?: string }) => void;
  onCancel: () => void;
}

export function ContactRecordCard({
  request,
  isSubmitting,
  accepted,
  onSubmit,
  onCancel,
}: ContactRecordCardProps) {
  const { t } = useTranslation("chat");
  // Render sites must key this card by `requestId` so a new request remounts
  // it and re-runs these initializers instead of keeping stale state.
  // What the form shows: the proposal when there is one, else what is stored.
  const seededName = request.displayName ?? request.currentDisplayName ?? "";
  const seededNotes = request.notes ?? request.currentNotes ?? "";
  // What the contact holds. A field is submitted when it differs from this, so
  // accepting a proposal writes it and leaving a field alone does not.
  const storedName = request.currentDisplayName ?? "";
  const storedNotes = request.currentNotes ?? "";
  const [displayName, setDisplayName] = useState(seededName);
  const [notes, setNotes] = useState(seededNotes);

  const isDelete = request.operation === "delete";
  const isCreate = request.operation === "create";
  const canSubmit =
    (isDelete || displayName.trim().length > 0) && !isSubmitting && !accepted;

  const heading =
    request.label ??
    t(
      isDelete
        ? "contactRecordCard.deleteTitle"
        : request.operation === "update"
          ? "contactRecordCard.updateTitle"
          : "contactRecordCard.createTitle",
      { name: request.currentDisplayName ?? "" },
    );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    // The name is trimmed because it is validated non-empty and a stray space
    // is never meant. Notes go as typed: trimming them here would let a rename
    // quietly rewrite notes the guardian never touched.
    //
    // A create says everything; an update says only what differs from the
    // stored contact, so a field left alone cannot overwrite an edit made
    // elsewhere while this form was open, and an accepted proposal is a real
    // change rather than a silent no-op.
    const trimmedName = displayName.trim();
    if (isCreate) {
      onSubmit({ displayName: trimmedName, notes });
      return;
    }
    onSubmit({
      displayName: trimmedName === storedName.trim() ? undefined : trimmedName,
      // A proposal the command made explicitly goes back whether or not it
      // matches: the stored value it would be compared against is missing
      // when the contact's notes could not be read.
      notes: request.notesProposed || notes !== storedNotes ? notes : undefined,
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Typography
            variant="label-small-default"
            className="text-[var(--content-primary)]"
          >
            {heading}
          </Typography>
          {request.description && (
            <Typography
              variant="body-small-default"
              className="text-[var(--content-secondary)]"
            >
              {request.description}
            </Typography>
          )}
          {isDelete && (
            <>
              <Typography
                variant="body-small-default"
                className="text-[var(--content-secondary)]"
              >
                {t("contactRecordCard.deleteWarning")}
              </Typography>
              {/* Two contacts can share a name, so the channels are how the
                  guardian tells which one this is, and they are also what is
                  about to be lost. */}
              {request.channels && request.channels.length > 0 ? (
                <ul className="mt-1 list-none">
                  {request.channels.map((channel) => (
                    <li
                      key={`${channel.type}:${channel.address}`}
                      className="text-body-small-default text-[var(--content-secondary)]"
                    >
                      {channel.type}: {channel.address}
                    </li>
                  ))}
                </ul>
              ) : (
                <Typography
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  {t("contactRecordCard.noChannels")}
                </Typography>
              )}
            </>
          )}
        </div>
        {!accepted && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="shrink-0 text-[var(--content-tertiary)] hover:text-[var(--content-secondary)]"
            aria-label={t("contactRecordCard.dismiss")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {accepted ? (
        // typography: off-scale, an inline status badge rather than prose

        <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
          <CheckCircle size={16} />
          {t(
            isDelete
              ? "contactRecordCard.contactDeleted"
              : "contactRecordCard.contactSaved",
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {!isDelete && (
            <>
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("contactRecordCard.namePlaceholder")}
                disabled={isSubmitting}
                autoFocus
              />
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("contactRecordCard.notesPlaceholder")}
                disabled={isSubmitting}
                rows={3}
              />
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              {t("contactRecordCard.cancel")}
            </Button>
            <Button
              type="submit"
              variant={isDelete ? "danger" : "primary"}
              disabled={!canSubmit}
              leftIcon={
                isSubmitting ? <Loader2 className="animate-spin" /> : undefined
              }
            >
              {isSubmitting
                ? t("contactRecordCard.saving")
                : t(
                    isDelete
                      ? "contactRecordCard.delete"
                      : "contactRecordCard.save",
                  )}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
