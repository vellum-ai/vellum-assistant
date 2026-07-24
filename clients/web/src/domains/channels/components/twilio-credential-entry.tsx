import { useState } from "react";

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
        label="Account SID"
        type="text"
        value={accountSid}
        onChange={(e) => setAccountSid(e.target.value)}
        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        disabled={saving}
        fullWidth
      />
      <Input
        label="Auth Token"
        type="password"
        value={authToken}
        onChange={(e) => setAuthToken(e.target.value)}
        placeholder="Twilio auth token"
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
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
