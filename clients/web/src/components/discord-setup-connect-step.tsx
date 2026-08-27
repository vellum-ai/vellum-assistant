import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { useTranslation } from "@/i18n";

export interface DiscordSetupConnectStepProps {
  botToken: string;
  saveStatus: MutationStatus;
  saveError: string | null;
  onBotTokenChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Bring the bot token back from the Discord developer portal.
 *
 * Saving is not the end of setup: the bot still has to be invited to a server
 * before it can receive anything, which is the step after this one.
 */
export function DiscordSetupConnectStep({
  botToken,
  saveStatus,
  saveError,
  onBotTokenChange,
  onSave,
}: DiscordSetupConnectStepProps) {
  const { t } = useTranslation();
  const canSave = botToken.trim().length > 0 && saveStatus !== "pending";

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        {t("discordSetupConnectStep.instructions")}
      </Typography>

      <Input
        label={t("discordSetupConnectStep.botTokenLabel")}
        type="password"
        value={botToken}
        onChange={(e) => onBotTokenChange(e.target.value)}
        placeholder={t("discordSetupConnectStep.botTokenPlaceholder")}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      {saveError ? <Notice tone="error">{saveError}</Notice> : null}

      {saveStatus === "success" ? (
        <Notice tone="success">{t("discordSetupConnectStep.saved")}</Notice>
      ) : null}

      <Button type="button" disabled={!canSave} onClick={onSave}>
        {saveStatus === "pending"
          ? t("discordSetupConnectStep.saving")
          : t("discordSetupConnectStep.save")}
      </Button>
    </div>
  );
}
