import { useQuery } from "@tanstack/react-query";
import { CheckCircle, Phone, Send } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, Input, Typography } from "@vellumai/design-library";

import { SlackSetupWizard } from "@/components/slack-setup-wizard";
import { DetailShell } from "@/domains/chat/components/detail-shell";
import { channelsReadinessGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSaveSlackConfig } from "@/hooks/use-save-slack-config";
import { useSaveTelegramConfig } from "@/hooks/use-save-telegram-config";
import { useSaveTwilioCredentials } from "@/hooks/use-save-twilio-credentials";
import type { ChannelSetupPayload, ChannelSetupType } from "@/stores/viewer-store";
import { publicAsset } from "@/utils/public-asset";

interface ChannelSetupPanelProps {
  payload: ChannelSetupPayload;
  onClose: () => void;
}

const CHANNEL_META: Record<
  ChannelSetupType,
  { label: string; connectedMessage: string }
> = {
  slack: {
    label: "Slack",
    connectedMessage: "Your assistant is ready to receive messages on Slack.",
  },
  telegram: {
    label: "Telegram",
    connectedMessage: "Your assistant is ready to receive messages on Telegram.",
  },
  phone: {
    label: "Phone",
    connectedMessage: "Your assistant is ready for phone calls via Twilio.",
  },
};

export function ChannelSetupPanel({ payload, onClose }: ChannelSetupPanelProps) {
  const meta = CHANNEL_META[payload.channel];

  const saveSlack = useSaveSlackConfig({
    assistantId: payload.assistantId,
    onSuccess: onClose,
  });
  const saveTelegram = useSaveTelegramConfig({
    assistantId: payload.assistantId,
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
      data.snapshots?.some(
        (s) => s.channel === payload.channel && s.ready,
      ) ?? false,
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
      title={isConnected ? `${meta.label} settings` : `${meta.label} setup`}
      closeLabel="Close setup panel"
      onClose={onClose}
    >
      {isConnected ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <CheckCircle className="h-8 w-8 text-[var(--content-positive)]" />
          <Typography variant="title-small" className="text-[color:var(--content-strong)]">
            {meta.label} is connected
          </Typography>
          <Typography variant="body-small-default" className="text-[color:var(--content-subtle)]">
            {meta.connectedMessage}
          </Typography>
          <Button variant="outlined" size="compact" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : payload.channel === "slack" ? (
        <SlackSetupWizard
          assistantName={payload.assistantName}
          onSave={(bot, app) => saveSlack.mutate({ botToken: bot, appToken: app })}
          saveStatus={saveSlack.status}
          saveError={saveSlack.error?.message ?? null}
        />
      ) : payload.channel === "telegram" ? (
        <TelegramCredentialForm
          status={saveTelegram.status}
          error={saveTelegram.error?.message ?? null}
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
// Telegram credential form
// ---------------------------------------------------------------------------

interface TelegramCredentialFormProps {
  status: "idle" | "pending" | "success" | "error";
  error: string | null;
  onSave: (botToken: string) => void;
}

function TelegramCredentialForm({
  status,
  error,
  onSave,
}: TelegramCredentialFormProps) {
  const [botToken, setBotToken] = useState("");

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Typography variant="body-small-default" className="text-[color:var(--content-secondary)]">
        Enter the bot token from{" "}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--content-link)] hover:underline"
        >
          @BotFather
        </a>
        . After saving, return to the chat — your assistant will finish
        configuring the webhook and bot commands.
      </Typography>
      <Input
        label="Bot Token"
        type="password"
        value={botToken}
        onChange={(e) => setBotToken(e.target.value)}
        placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
        disabled={status === "pending"}
        fullWidth
      />
      {status === "error" && error ? (
        <Typography variant="body-small-default" className="text-[color:var(--system-negative-strong)]">
          {error}
        </Typography>
      ) : null}
      {status === "success" ? (
        <Typography variant="body-small-default" className="text-[color:var(--content-positive)]">
          Credentials saved. Return to the chat to finish setup.
        </Typography>
      ) : null}
      <div>
        <Button
          onClick={() => onSave(botToken)}
          disabled={!botToken.trim() || status === "pending"}
        >
          {status === "pending" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
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
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <Typography variant="body-small-default" className="text-[color:var(--content-secondary)]">
        Enter your Twilio credentials from the{" "}
        <a
          href="https://console.twilio.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--content-link)] hover:underline"
        >
          Twilio Console
        </a>
        . After saving, return to the chat — your assistant will finish
        configuring your phone number and webhooks.
      </Typography>
      <Input
        label="Account SID"
        type="text"
        value={accountSid}
        onChange={(e) => setAccountSid(e.target.value)}
        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        disabled={status === "pending"}
        fullWidth
      />
      <Input
        label="Auth Token"
        type="password"
        value={authToken}
        onChange={(e) => setAuthToken(e.target.value)}
        placeholder="Twilio auth token"
        disabled={status === "pending"}
        fullWidth
      />
      {status === "error" && error ? (
        <Typography variant="body-small-default" className="text-[color:var(--system-negative-strong)]">
          {error}
        </Typography>
      ) : null}
      {status === "success" ? (
        <Typography variant="body-small-default" className="text-[color:var(--content-positive)]">
          Credentials saved. Return to the chat to finish setup.
        </Typography>
      ) : null}
      <div>
        <Button
          onClick={() => onSave(accountSid, authToken)}
          disabled={
            !accountSid.trim() || !authToken.trim() || status === "pending"
          }
        >
          {status === "pending" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
