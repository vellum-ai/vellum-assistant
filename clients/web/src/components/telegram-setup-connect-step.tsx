import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { Trans, useTranslation } from "@/i18n";
import { validateTelegramToken } from "@/utils/telegram-token-validation";

export interface TelegramSetupConnectStepProps {
  botToken: string;
  saveStatus: MutationStatus;
  saveError: string | null;
  onBotTokenChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Step 2 of `TelegramSetupWizard`: bring the token back from BotFather.
 *
 * Saving is not the end of setup. Delivery still has to be confirmed and the
 * user's identity linked before anything reaches them, which the assistant
 * does. The chat drawer closes on a successful save and hands off, so this
 * success state is what the Channels page shows, where nothing is listening
 * and the user picks it up next time they chat.
 */
export function TelegramSetupConnectStep({
  botToken,
  saveStatus,
  saveError,
  onBotTokenChange,
  onSave,
}: TelegramSetupConnectStepProps) {
  const { t } = useTranslation();
  const tokenError = validateTelegramToken(botToken);
  const canSave =
    botToken.trim().length > 0 && !tokenError && saveStatus !== "pending";

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        <Trans
          i18nKey="telegramSetupConnectStep.instructions"
          components={{ tokenLine: <strong /> }}
        />
      </Typography>

      <Input
        label={t("telegramSetupConnectStep.botTokenLabel")}
        type="password"
        value={botToken}
        onChange={(e) => onBotTokenChange(e.target.value)}
        placeholder="123456789:AA..."
        errorText={tokenError ?? undefined}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      <Button
        type="button"
        variant="primary"
        className="self-start"
        onClick={onSave}
        disabled={!canSave}
      >
        {saveStatus === "pending"
          ? t("telegramSetupConnectStep.saving")
          : t("telegramSetupConnectStep.connectTelegram")}
      </Button>

      {saveStatus === "success" && (
        <Notice tone="success">
          {t("telegramSetupConnectStep.successNotice")}
        </Notice>
      )}
      {saveStatus === "error" && saveError && (
        <Notice tone="error">{saveError}</Notice>
      )}
    </div>
  );
}
