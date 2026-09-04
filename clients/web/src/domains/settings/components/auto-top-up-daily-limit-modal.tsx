import { Loader2 } from "lucide-react";
import { useState, type ChangeEvent, type KeyboardEvent } from "react";

import {
  DailyCreditLimitInput,
  validateDailyLimit,
} from "@/domains/settings/components/daily-credit-limit-input";
import { useDailyCreditLimitUpdate } from "@/domains/settings/hooks/use-daily-credit-limit-update";
import { extractDrfFieldErrors } from "@/domains/settings/utils/drf-errors";
import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";

/** Limit proposed when the org has none; the user edits it before saving. */
export const DEFAULT_DAILY_CREDIT_LIMIT_USD = "25";

export interface AutoTopUpDailyLimitModalProps {
  /** The limit is saved and the daily-limit query cache already reflects it. */
  onSaved: () => void;
  /** The user declined to set a limit (button, Escape, or overlay click). */
  onCancel: () => void;
}

/**
 * Gate shown when Save is pressed on the auto-reload form while the org has
 * no daily credit limit. The backend requires one while auto-reload is on, so
 * the user sets it here before the auto-reload config is persisted, or
 * declines and auto-reload stays off. The field is the card's own
 * `DailyCreditLimitInput` and the PUT body is the same two-decimal string, so
 * the saved value shows up in `DailyCreditLimitCard` unchanged with its
 * toggle on.
 *
 * Mounting opens the dialog and the parent unmounts it to close, which also
 * resets the draft and any failed save. Built on `Modal.*` rather than
 * `ConfirmDialog` so focus lands on the input and Enter submits it.
 */
export function AutoTopUpDailyLimitModal({
  onSaved,
  onCancel,
}: AutoTopUpDailyLimitModalProps) {
  const { t } = useTranslation("settings");
  const updateMutation = useDailyCreditLimitUpdate();
  const [value, setValue] = useState(DEFAULT_DAILY_CREDIT_LIMIT_USD);
  const [touched, setTouched] = useState(false);

  const saving = updateMutation.isPending;
  const clientError = validateDailyLimit(value);
  const visibleError = touched ? clientError : undefined;

  // A rejected save comes back as a DRF field error when the backend has
  // something specific to say; show it verbatim over the generic copy.
  const serverLimitError = extractDrfFieldErrors(
    updateMutation.error,
  ).daily_credit_limit_usd;
  const saveError =
    serverLimitError ??
    (updateMutation.isError ? t("dailyCreditLimitCard.saveError") : undefined);

  // Enter reaches here past the disabled Save button, so the in-flight guard
  // lives on the handler: overlapping PUTs could otherwise settle out of order
  // and leave an earlier limit on file when auto-reload turns on.
  const handleSave = () => {
    if (saving) {
      return;
    }
    setTouched(true);
    if (clientError) {
      return;
    }
    updateMutation.mutate(
      { body: { daily_credit_limit_usd: parseFloat(value.trim()).toFixed(2) } },
      { onSuccess: onSaved },
    );
  };

  const dismiss = () => {
    if (!saving) {
      onCancel();
    }
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          dismiss();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }}
        data-testid="auto-top-up-daily-limit-modal"
      >
        <Modal.Header>
          <Modal.Title>{t("autoTopUpDailyLimitModal.title")}</Modal.Title>
          <Modal.Description>
            {t("autoTopUpDailyLimitModal.message")}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          <DailyCreditLimitInput
            value={value}
            onChange={onChange}
            onBlur={() => setTouched(true)}
            onKeyDown={onKeyDown}
            errorText={visibleError}
            disabled={saving}
            data-testid="auto-top-up-daily-limit-input"
          />
          {saveError != null && (
            <Notice
              tone="error"
              className="mt-3"
              data-testid="auto-top-up-daily-limit-error"
            >
              {saveError}
            </Notice>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outlined"
            onClick={dismiss}
            disabled={saving}
            data-testid="auto-top-up-daily-limit-cancel-button"
          >
            {t("autoTopUpDailyLimitModal.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
            leftIcon={saving ? <Loader2 className="animate-spin" /> : undefined}
            data-testid="auto-top-up-daily-limit-save-button"
          >
            {saving
              ? t("autoTopUpDailyLimitModal.saving")
              : t("autoTopUpDailyLimitModal.save")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
