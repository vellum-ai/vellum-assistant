import { Button, Input, Notice, Typography } from "@vellumai/design-library";
import type { MutationStatus } from "@/components/channel-setup-wizard";
import { Trans, useTranslation } from "@/i18n";
import {
  APP_TOKEN_PREFIX,
  BOT_TOKEN_PREFIX,
  validateSlackToken,
} from "@/utils/slack-token-validation";

import { ChannelAvatarDownload } from "@/components/channel-avatar-download";
export interface SlackSetupTokensStepProps {
  /** Assistant the setup panel was opened for. */
  assistantId: string;
  botToken: string;
  appToken: string;
  saveStatus: MutationStatus;
  saveError: string | null;
  onBotTokenChange: (value: string) => void;
  onAppTokenChange: (value: string) => void;
  onSave: () => void;
}

/**
 * Step 4 of `SlackSetupWizard`: bring both tokens back from Slack.
 *
 * Slack mints the `xapp-` app token alongside the `xoxb-` bot token on Create
 * and Install, so both are collected here rather than across separate steps.
 *
 * The avatar card sits here rather than on the create step because an app icon
 * cannot be set until the app exists: it is absent from the manifest schema,
 * and the create step leaves the user in a modal for an app Slack has not made
 * yet. By this step they are on the app's own screen.
 */
export function SlackSetupTokensStep({
  assistantId,
  botToken,
  appToken,
  saveStatus,
  saveError,
  onBotTokenChange,
  onAppTokenChange,
  onSave,
}: SlackSetupTokensStepProps) {
  const { t } = useTranslation();
  const botTokenError = validateSlackToken(
    botToken,
    BOT_TOKEN_PREFIX,
    t("slackSetupTokensStep.botTokenLabel"),
  );
  const appTokenError = validateSlackToken(
    appToken,
    APP_TOKEN_PREFIX,
    t("slackSetupTokensStep.appTokenLabel"),
  );

  const canSave =
    botToken.trim().length > 0 &&
    appToken.trim().length > 0 &&
    !botTokenError &&
    !appTokenError &&
    saveStatus !== "pending";

  return (
    <div className="flex flex-col gap-4">
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="text-[color:var(--content-default)]"
      >
        <Trans
          i18nKey="slackSetupTokensStep.instructions"
          components={{ credentials: <strong /> }}
        />
      </Typography>

      <Notice tone="warning">
        <Trans
          i18nKey="slackSetupTokensStep.skipNotice"
          components={{ download: <strong /> }}
        />
      </Notice>

      <Input
        label={t("slackSetupTokensStep.botTokenLabel")}
        type="password"
        value={botToken}
        onChange={(e) => onBotTokenChange(e.target.value)}
        placeholder={`${BOT_TOKEN_PREFIX}...`}
        errorText={botTokenError ?? undefined}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      <Input
        label={t("slackSetupTokensStep.appTokenLabel")}
        type="password"
        value={appToken}
        onChange={(e) => onAppTokenChange(e.target.value)}
        placeholder={`${APP_TOKEN_PREFIX}...`}
        errorText={appTokenError ?? undefined}
        disabled={saveStatus === "pending"}
        fullWidth
      />

      <ChannelAvatarDownload assistantId={assistantId} channel="slack" />

      <Button
        type="button"
        variant="primary"
        className="self-start"
        onClick={onSave}
        disabled={!canSave}
      >
        {saveStatus === "pending"
          ? t("slackSetupTokensStep.connecting")
          : t("slackSetupTokensStep.connectSlack")}
      </Button>

      {saveStatus === "success" && (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[color:var(--content-positive)]"
        >
          {t("slackSetupTokensStep.credentialsSaved")}
        </Typography>
      )}
      {saveStatus === "error" && saveError && (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[color:var(--system-negative-strong)]"
        >
          {saveError}
        </Typography>
      )}
    </div>
  );
}
