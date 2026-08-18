import { useState } from "react";

import { useTranslation } from "@/i18n";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

interface TwilioCredentialEntryProps {
  onSave?: (accountSid: string, authToken: string) => Promise<void>;
}

/**
 * Manual Twilio credential entry for a disconnected Phone panel: Account SID +
 * Auth Token fields plus a Save button that trims, submits, clears on success,
 * and surfaces a save error. Rendered only while disconnected.
 */
export function TwilioCredentialEntry({ onSave }: TwilioCredentialEntryProps) {
  const { t } = useTranslation("channels");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    accountSid.trim().length > 0 && authToken.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!onSave || !canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(accountSid.trim(), authToken.trim());
      setAccountSid("");
      setAuthToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        label={t("twilioCredentialEntry.accountSid")}
        type="text"
        value={accountSid}
        onChange={(e) => setAccountSid(e.target.value)}
        // eslint-disable-next-line local/no-untranslated-strings -- Twilio SID format, identical in every language
        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        disabled={saving}
        fullWidth
      />
      <Input
        label={t("twilioCredentialEntry.authToken")}
        type="password"
        value={authToken}
        onChange={(e) => setAuthToken(e.target.value)}
        placeholder={t("twilioCredentialEntry.authTokenPlaceholder")}
        disabled={saving}
        fullWidth
      />
      {error ? (
        <p
          className="text-label-small"
          style={{ color: "var(--content-negative)" }}
        >
          {error}
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={handleSave} disabled={!canSave}>
          {saving
            ? t("twilioCredentialEntry.saving")
            : t("twilioCredentialEntry.save")}
        </Button>
      </div>
    </div>
  );
}
