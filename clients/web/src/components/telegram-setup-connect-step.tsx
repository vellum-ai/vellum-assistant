import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import { ChannelSetupCompleteNotice } from "@/components/channel-setup-complete-notice";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { Trans, useTranslation } from "@/i18n";
import { validateTelegramToken } from "@/utils/telegram-token-validation";

export interface TelegramSetupConnectStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  botToken: string;
  saveStatus: MutationStatus;
  saveError: string | null;
  onBotTokenChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Step 2 of `TelegramSetupWizard`: bring the token back from BotFather.
 *
 * Saving is not the end of setup: until the guardian's Telegram identity is
 * linked, the default admission policy leaves the bot seeing their messages
 * and declining to answer. The chat drawer closes on a successful save and
 * hands off to the assistant, so this success state is only ever the Channels
 * page's, where no conversation is listening and the copy has to tell the
 * user what to say instead.
 */
export function TelegramSetupConnectStep({
  assistantId,
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

  // A saved credential retires the form. The wizard empties the field on
  // success, so leaving it up would pair "Token saved" with a blank box and a
  // dead button, which reads as a save that did not take.
  if (saveStatus === "success") {
    return (
      <ChannelSetupCompleteNotice
        assistantId={assistantId}
        channel="telegram"
        savedTitle={t("telegramSetupConnectStep.savedTitle")}
        savedBody={t("telegramSetupConnectStep.savedBody")}
      />
    );
  }

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

      {saveStatus === "error" && saveError && (
        <Notice tone="error">{saveError}</Notice>
      )}
    </div>
  );
}
