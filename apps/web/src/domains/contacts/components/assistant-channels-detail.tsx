import { CheckCircle, ChevronDown, ChevronRight, Hash, Phone, Send } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";

import { DetailCard } from "@/components/detail-card";
import { ContactTypeBadge } from "@/domains/contacts/components/contact-type-badge";
import { ShareConnectionLinkButton } from "@/domains/contacts/components/share-connection-link-button";
import type { AssistantChannelState } from "@/domains/contacts/types";

type ChannelKey = AssistantChannelState["key"];

interface AssistantChannelsDetailProps {
  assistantName: string;
  channels: AssistantChannelState[];
  pendingChannelKey?: ChannelKey | null;
  onSetup?: (channelKey: ChannelKey) => void;
  onDisconnect?: (channelKey: ChannelKey) => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
  onSaveSlackConfig?: (botToken: string, appToken: string) => Promise<void>;
  onSaveTwilioCredentials?: (accountSid: string, authToken: string) => Promise<void>;
  onGenerateInviteLink?: () => void;
}

const CHANNEL_META: Record<
  ChannelKey,
  { label: string; Icon: typeof Hash; disconnectMessage: string }
> = {
  slack: {
    label: "Slack",
    Icon: Hash,
    disconnectMessage:
      "This clears the stored Slack bot and app tokens for this assistant. You can reconnect later.",
  },
  telegram: {
    label: "Telegram",
    Icon: Send,
    disconnectMessage:
      "This clears the stored Telegram bot token for this assistant. You can reconnect later.",
  },
  phone: {
    label: "Phone Calling",
    Icon: Phone,
    disconnectMessage:
      "This clears the stored Twilio credentials for this assistant. You can reconnect later.",
  },
};

export function AssistantChannelsDetail({
  assistantName,
  channels,
  pendingChannelKey = null,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  onSaveSlackConfig,
  onSaveTwilioCredentials,
  onGenerateInviteLink,
}: AssistantChannelsDetailProps) {
  const displayName = assistantName.trim() || "your assistant";
  const [pendingDisconnect, setPendingDisconnect] = useState<ChannelKey | null>(null);
  const [expandedChannels, setExpandedChannels] = useState<Set<ChannelKey>>(new Set());

  const disconnectMeta = pendingDisconnect ? CHANNEL_META[pendingDisconnect] : null;

  const toggleExpanded = (key: ChannelKey) => {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <DetailCard
        title={`${displayName} (Your Assistant)`}
        accessory={<ContactTypeBadge role="assistant" />}
        compactAccessory
      />

      <DetailCard
        title="Channels"
        subtitle={`Manage where ${displayName} can be reached.`}
      >
        <div className="flex flex-col">
          {channels.map((channel, index) => (
            <div key={channel.key}>
              {index > 0 ? (
                <div
                  className="border-t"
                  style={{ borderColor: "var(--border-base)" }}
                />
              ) : null}
              <ChannelRow
                channel={channel}
                pending={pendingChannelKey === channel.key}
                expanded={expandedChannels.has(channel.key)}
                onToggleExpand={() => toggleExpanded(channel.key)}
                onSetup={onSetup ? () => onSetup(channel.key) : undefined}
                onDisconnect={
                  onDisconnect ? () => setPendingDisconnect(channel.key) : undefined
                }
                onSaveTelegramToken={onSaveTelegramToken}
                onSaveSlackConfig={onSaveSlackConfig}
                onSaveTwilioCredentials={onSaveTwilioCredentials}
              />
            </div>
          ))}
        </div>
      </DetailCard>

      {onGenerateInviteLink ? <ShareConnectionLinkButton onClick={onGenerateInviteLink} /> : null}

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title={`Disconnect ${disconnectMeta?.label ?? ""}?`}
        message={disconnectMeta?.disconnectMessage ?? ""}
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => {
          if (pendingDisconnect && onDisconnect) {
            onDisconnect(pendingDisconnect);
          }
          setPendingDisconnect(null);
        }}
        onCancel={() => setPendingDisconnect(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel Row
// ---------------------------------------------------------------------------

interface ChannelRowProps {
  channel: AssistantChannelState;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSetup?: () => void;
  onDisconnect?: () => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
  onSaveSlackConfig?: (botToken: string, appToken: string) => Promise<void>;
  onSaveTwilioCredentials?: (accountSid: string, authToken: string) => Promise<void>;
}

function ChannelRow({
  channel,
  pending,
  expanded,
  onToggleExpand,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  onSaveSlackConfig,
  onSaveTwilioCredentials,
}: ChannelRowProps) {
  const meta = CHANNEL_META[channel.key];
  const connected = channel.status === "ready";
  const isExpandable = connected ? channel.key !== "slack" : true;

  return (
    <div className="flex flex-col gap-2 py-4">
      <div className="flex items-center gap-3">
        {isExpandable ? (
          <button
            type="button"
            className="flex shrink-0 items-center justify-center"
            onClick={onToggleExpand}
            style={{ color: "var(--content-secondary)" }}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <meta.Icon
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--content-secondary)" }}
          />
        )}
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {meta.label}
        </span>
        {channel.address ? (
          <span className="text-body-medium-lighter" style={{ color: "var(--content-tertiary)" }}>
            {channel.address}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {connected ? (
            <>
              <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
                <CheckCircle className="h-3 w-3" />
                Connected
              </span>
              <Button
                type="button"
                variant="danger"
                onClick={onDisconnect}
                disabled={!onDisconnect || pending}
              >
                {pending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outlined"
              onClick={onSetup}
              disabled={!onSetup || pending}
            >
              {pending ? "Opening…" : "Set up"}
            </Button>
          )}
        </div>
      </div>

      {!connected && channel.key === "telegram" && expanded ? (
        <TelegramCredentialEntry onSave={onSaveTelegramToken} />
      ) : null}

      {!connected && channel.key === "slack" && expanded ? (
        <SlackCredentialEntry onSave={onSaveSlackConfig} />
      ) : null}

      {!connected && channel.key === "phone" && expanded ? (
        <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />
      ) : null}

      {connected && channel.key === "telegram" && expanded ? (
        <TelegramCredentialEntry onSave={onSaveTelegramToken} />
      ) : null}

      {connected && channel.key === "phone" && expanded ? (
        <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credential Entry Forms
// ---------------------------------------------------------------------------

interface TelegramCredentialEntryProps {
  onSave?: (botToken: string) => Promise<void>;
}

function TelegramCredentialEntry({ onSave }: TelegramCredentialEntryProps) {
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
    <div className="flex flex-col gap-3 pl-7">
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
        <p className="text-label-small" style={{ color: "var(--content-negative)" }}>
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface SlackCredentialEntryProps {
  onSave?: (botToken: string, appToken: string) => Promise<void>;
}

function SlackCredentialEntry({ onSave }: SlackCredentialEntryProps) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = botToken.trim().length > 0 && appToken.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!onSave || !canSave) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(botToken.trim(), appToken.trim());
      setBotToken("");
      setAppToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pl-7">
      <Input
        label="Bot Token"
        type="password"
        value={botToken}
        onChange={(e) => setBotToken(e.target.value)}
        placeholder="xoxb-..."
        disabled={saving}
        fullWidth
      />
      <Input
        label="App Token"
        type="password"
        value={appToken}
        onChange={(e) => setAppToken(e.target.value)}
        placeholder="xapp-..."
        disabled={saving}
        fullWidth
      />
      {error ? (
        <p className="text-label-small" style={{ color: "var(--content-negative)" }}>
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface TwilioCredentialEntryProps {
  onSave?: (accountSid: string, authToken: string) => Promise<void>;
}

function TwilioCredentialEntry({ onSave }: TwilioCredentialEntryProps) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = accountSid.trim().length > 0 && authToken.trim().length > 0 && !saving;

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
    <div className="flex flex-col gap-3 pl-7">
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
        <p className="text-label-small" style={{ color: "var(--content-negative)" }}>
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
