import { useQuery } from "@tanstack/react-query";
import { CheckCircle, Phone, Send } from "lucide-react";
import { useMemo, useState } from "react";

import { Trans, useTranslation } from "@/i18n";

import { Button, Input, Typography } from "@vellumai/design-library";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { TelegramSetupWizard } from "@/components/telegram-setup-wizard";
import { DetailShell } from "@/components/detail-shell";
import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import { useSaveTelegramConfig } from "@/hooks/use-save-telegram-config";
import { useSaveTwilioCredentials } from "@/hooks/use-save-twilio-credentials";
import type {
  ChannelSetupPayload,
  ChannelSetupType,
} from "@/stores/viewer-store";
import { publicAsset } from "@/utils/public-asset";

interface ChannelSetupPanelProps {
  payload: ChannelSetupPayload;
  onClose: () => void;
}

const CHANNEL_BRAND_LABEL: Record<ChannelSetupType, string | null> = {
  slack: "Slack",
  telegram: "Telegram",
  phone: null,
};

export function ChannelSetupPanel({
  payload,
  onClose,
}: ChannelSetupPanelProps) {
  const { t } = useTranslation("chat");
  const channelLabel =
    CHANNEL_BRAND_LABEL[payload.channel] ?? t("channelSetupPanel.phoneLabel");
  const connectedMessage =
    payload.channel === "slack"
      ? t("channelSetupPanel.slackConnected")
      : payload.channel === "telegram"
        ? t("channelSetupPanel.telegramConnected")
        : t("channelSetupPanel.phoneConnected");

  const saveSlack = useSaveSlackConfig({
    assistantId: payload.assistantId,
    onSuccess: onClose,
  });
  // Closing on success is what hands off to the assistant: the drawer closing
  // is what emits the wizard-closed notification the telegram-setup skill
  // waits on. Slack already does this; leaving Telegram open made its handoff
  // depend on the user knowing to close the panel themselves.
  const saveTelegram = useSaveTelegramConfig({
    assistantId: payload.assistantId,
    onSuccess: onClose,
  });
  const saveTwilio = useSaveTwilioCredentials({
    assistantId: payload.assistantId,
  });

  const readinessOpts = useMemo(
    () => ({ path: { assistant_id: payload.assistantId } }),
    [payload.assistantId],
  );
  const readinessQuery = useQuery({
    ...channelsReadinessGetOptions(readinessOpts),
    select: (data) =>
      data.snapshots?.some((s) => s.channel === payload.channel && s.ready) ??
      false,
  });
  const isConnected = readinessQuery.data === true;

  const channelIcon =
    payload.channel === "slack" ? (
      <img
        src={publicAsset("/images/integrations/slack.svg")}
        alt=""
        className="size-5 shrink-0"
      />
    ) : undefined;

  const channelGlyph =
    payload.channel === "telegram"
      ? Send
      : payload.channel === "phone"
        ? Phone
        : undefined;

  return (
    <DetailShell
      icon={channelIcon}
      Glyph={channelGlyph}
      title={
        isConnected
          ? t("channelSetupPanel.settingsTitle", { channel: channelLabel })
          : t("channelSetupPanel.setupTitle", { channel: channelLabel })
      }
      closeLabel={t("channelSetupPanel.closeSetupAria")}
      onClose={onClose}
    >
      {isConnected ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle className="h-8 w-8 text-[var(--content-positive)]" />
          <Typography
            variant="title-small"
            className="text-[color:var(--content-strong)]"
          >
            {t("channelSetupPanel.connectedHeading", { channel: channelLabel })}
          </Typography>
          <Typography
            variant="body-small-default"
            className="text-[color:var(--content-subtle)]"
          >
            {connectedMessage}
          </Typography>
          <Button variant="outlined" size="compact" onClick={onClose}>
            {t("channelSetupPanel.close")}
          </Button>
        </div>
      ) : payload.channel === "slack" ? (
        <SlackSetupWizard
          assistantName={payload.assistantName}
          onSave={(bot, app) =>
            saveSlack.mutate({ botToken: bot, appToken: app })
          }
          saveStatus={saveSlack.status}
          saveError={saveSlack.error?.message ?? null}
        />
      ) : payload.channel === "telegram" ? (
        <TelegramSetupWizard
          assistantName={payload.assistantName}
          saveStatus={saveTelegram.status}
          saveError={saveTelegram.error?.message ?? null}
          onSave={(botToken) => saveTelegram.mutate(botToken)}
        />
      ) : payload.channel === "phone" ? (
        <TwilioCredentialForm
          status={saveTwilio.status}
          error={saveTwilio.error?.message ?? null}
          onSave={(accountSid, authToken) =>
            saveTwilio.mutate({ accountSid, authToken })
          }
        />
      ) : null}
    </DetailShell>
  );
}

// ---------------------------------------------------------------------------
// Twilio credential form
// ---------------------------------------------------------------------------

interface TwilioCredentialFormProps {
  status: "idle" | "pending" | "success" | "error";
  error: string | null;
  onSave: (accountSid: string, authToken: string) => void;
}

function TwilioCredentialForm({
  status,
  error,
  onSave,
}: TwilioCredentialFormProps) {
  const { t } = useTranslation("chat");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Typography
        variant="body-small-default"
        className="text-[color:var(--content-secondary)]"
      >
        <Trans
          ns="chat"
          i18nKey="channelSetupPanel.twilioIntro"
          components={{
            consoleLink: (
              <a
                href="https://console.twilio.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[color:var(--content-link)] hover:underline"
              />
            ),
          }}
        />
      </Typography>
      <Input
        label={t("channelSetupPanel.accountSid")}
        type="text"
        value={accountSid}
        onChange={(e) => setAccountSid(e.target.value)}
        placeholder={t("channelSetupPanel.accountSidPlaceholder")}
        disabled={status === "pending"}
        fullWidth
      />
      <Input
        label={t("channelSetupPanel.authToken")}
        type="password"
        value={authToken}
        onChange={(e) => setAuthToken(e.target.value)}
        placeholder={t("channelSetupPanel.authTokenPlaceholder")}
        disabled={status === "pending"}
        fullWidth
      />
      {status === "error" && error ? (
        <Typography
          variant="body-small-default"
          className="text-[color:var(--system-negative-strong)]"
        >
          {error}
        </Typography>
      ) : null}
      {status === "success" ? (
        <Typography
          variant="body-small-default"
          className="text-[color:var(--content-positive)]"
        >
          {t("channelSetupPanel.credentialsSaved")}
        </Typography>
      ) : null}
      <div>
        <Button
          onClick={() => onSave(accountSid, authToken)}
          disabled={
            !accountSid.trim() || !authToken.trim() || status === "pending"
          }
        >
          {status === "pending" ? t("channelSetupPanel.saving") : t("channelSetupPanel.save")}
        </Button>
      </div>
    </div>
  );
}
