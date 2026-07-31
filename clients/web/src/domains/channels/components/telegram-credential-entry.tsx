import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";

interface TelegramCredentialEntryProps {
  onSave?: (botToken: string) => Promise<void>;
}

/**
 * Manual Telegram bot-token entry for a disconnected Telegram panel: a password
 * field plus a Save button that trims, submits, clears on success, and surfaces
 * a save error. Rendered only while disconnected — a connected channel has no
 * token field (parity with Slack's setup wizard).
 */
export function TelegramCredentialEntry({
  onSave,
}: TelegramCredentialEntryProps) {
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = botToken.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!onSave || !canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(botToken.trim());
      setBotToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Input
        label="Bot Token"
        type="password"
        value={botToken}
        onChange={(e) => setBotToken(e.target.value)}
        placeholder="Paste your Telegram bot token"
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
