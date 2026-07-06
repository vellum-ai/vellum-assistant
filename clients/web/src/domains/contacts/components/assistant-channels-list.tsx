import { CheckCircle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Typography } from "@vellumai/design-library/components/typography";

import { assistantDisplayName as toAssistantDisplayName } from "@/domains/contacts/assistant-display-name";
import { SlackChannelCard } from "@/domains/contacts/components/slack-channel-card";
import { SlackSetupWizard, type SlackThreadMode, type MutationStatus } from "@/components/slack-setup-wizard";
import type { AssistantChannelState, SetupChannelId } from "@/domains/contacts/types";
import {
  ADMISSION_POLICY_DEFAULT,
  ADMISSION_POLICY_VALUES,
  getPolicyDescriptions,
  POLICY_LABELS,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";

type ChannelKey = SetupChannelId;

/**
 * Floors that loosen or hard-deny who can reach the assistant and warrant an
 * explicit confirmation before persisting. Floors not listed here apply
 * immediately. Web-only UI concern — the cross-surface contract lives in
 * `@/lib/channel-admission-policy/types`.
 */
const POLICY_CONFIRMATIONS: Partial<
  Record<
    AdmissionPolicy,
    { title: string; message: string; confirmLabel: string; destructive?: boolean }
  >
> = {
  no_one: {
    title: "Block all messages?",
    message:
      "Setting this channel to “No one” hard-denies every inbound message — including messages from you.\n\nYou can reverse this at any time.",
    confirmLabel: "Block all",
    destructive: true,
  },
  any_contact: {
    title: "Allow any contact?",
    message:
      "“Any contact” admits every matched contact in this channel — including pending, unverified ones — not just your verified contacts.\n\nBest for channels consisting of only people you already trust.",
    confirmLabel: "Allow any contact",
  },
  strangers: {
    title: "Allow strangers?",
    message:
      "Are you sure you want to allow strangers to contact your assistant through this channel?\n\nDoing so could cost you money and open you up to security and privacy vulnerabilities.\n\nEnable with extreme caution.",
    confirmLabel: "Allow strangers",
    destructive: true,
  },
};

export interface AssistantChannelsListProps {
  assistantName: string;
  channels: AssistantChannelState[];
  pendingChannelKey?: ChannelKey | null;
  slackThreadMode?: SlackThreadMode;
  slackThreadModePending?: boolean;
  /**
   * Per-channel admission floor, keyed by channel. Omit (or pass no
   * `onChannelPolicyChange`) to hide the trust-floor control entirely — used
   * when the `channelTrustFloors` flag is off.
   */
  channelPolicies?: Partial<Record<ChannelKey, AdmissionPolicy>>;
  policySavingKey?: ChannelKey | null;
  policiesLoading?: boolean;
  policiesError?: boolean;
  onChannelPolicyChange?: (channelKey: ChannelKey, policy: AdmissionPolicy) => void;
  onSetup?: (channelKey: ChannelKey) => void;
  onDisconnect?: (channelKey: ChannelKey) => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
  onSaveSlackConfig?: (botToken: string, appToken: string) => void;
  slackSaveStatus?: MutationStatus;
  slackSaveError?: string | null;
  onSlackThreadModeChange?: (mode: SlackThreadMode) => void;
  onSaveTwilioCredentials?: (accountSid: string, authToken: string) => Promise<void>;
  /** Pre-expand a channel on mount (e.g. from a `?setup=slack` deep-link). */
  initialExpandedChannel?: ChannelKey | null;
}

const CHANNEL_META: Record<
  ChannelKey,
  { label: string; disconnectMessage: string }
> = {
  slack: {
    label: "Slack",
    disconnectMessage:
      "This clears the stored Slack bot and app tokens for this assistant. You can reconnect later.",
  },
  telegram: {
    label: "Telegram",
    disconnectMessage:
      "This clears the stored Telegram bot token for this assistant. You can reconnect later.",
  },
  phone: {
    label: "Phone Calling",
    disconnectMessage:
      "This clears the stored Twilio credentials for this assistant. You can reconnect later.",
  },
};

/**
 * The Slack/Telegram/Phone accordion rows plus their disconnect and
 * trust-floor confirmation dialogs. Owns which rows are expanded and which
 * confirmations are pending; the queries and mutations behind the props live
 * in `useAssistantChannels`. Rendered inside a card by both mount points —
 * the Channels tab and the Contacts assistant detail.
 */
export function AssistantChannelsList({
  assistantName,
  channels,
  pendingChannelKey = null,
  slackThreadMode,
  slackThreadModePending = false,
  channelPolicies,
  policySavingKey = null,
  policiesLoading = false,
  policiesError = false,
  onChannelPolicyChange,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  onSaveSlackConfig,
  slackSaveStatus,
  slackSaveError,
  onSlackThreadModeChange,
  onSaveTwilioCredentials,
  initialExpandedChannel = null,
}: AssistantChannelsListProps) {
  const [pendingDisconnect, setPendingDisconnect] = useState<ChannelKey | null>(null);
  const [expandedChannels, setExpandedChannels] = useState<Set<ChannelKey>>(
    () => initialExpandedChannel ? new Set([initialExpandedChannel]) : new Set(),
  );
  // Floor confirmation: non-null while a floor in POLICY_CONFIRMATIONS awaits
  // the user's go-ahead before persisting.
  const [pendingPolicy, setPendingPolicy] = useState<{
    channelKey: ChannelKey;
    policy: AdmissionPolicy;
  } | null>(null);

  const displayName = toAssistantDisplayName(assistantName);
  const disconnectMeta = pendingDisconnect ? CHANNEL_META[pendingDisconnect] : null;
  const pendingConfirmation = pendingPolicy
    ? POLICY_CONFIRMATIONS[pendingPolicy.policy]
    : null;

  // Floors that loosen or hard-deny access prompt a confirmation before
  // persisting; every other floor applies immediately.
  const handlePolicyChange = (channelKey: ChannelKey, next: AdmissionPolicy) => {
    if (POLICY_CONFIRMATIONS[next]) {
      setPendingPolicy({ channelKey, policy: next });
      return;
    }
    onChannelPolicyChange?.(channelKey, next);
  };

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
            assistantName={assistantName}
            assistantDisplayName={displayName}
            pending={pendingChannelKey === channel.key}
            expanded={expandedChannels.has(channel.key)}
            onToggleExpand={() => toggleExpanded(channel.key)}
            onSetup={
              channel.key === "slack"
                ? () => {
                    setExpandedChannels((prev) => {
                      const next = new Set(prev);
                      next.add(channel.key);
                      return next;
                    });
                  }
                : onSetup
                  ? () => onSetup(channel.key)
                  : undefined
            }
            onDisconnect={
              onDisconnect ? () => setPendingDisconnect(channel.key) : undefined
            }
            onSaveTelegramToken={onSaveTelegramToken}
            onSaveSlackConfig={onSaveSlackConfig}
            slackSaveStatus={slackSaveStatus}
            slackSaveError={slackSaveError}
            slackThreadMode={slackThreadMode}
            slackThreadModePending={slackThreadModePending}
            onSlackThreadModeChange={onSlackThreadModeChange}
            onSaveTwilioCredentials={onSaveTwilioCredentials}
            policy={channelPolicies?.[channel.key]}
            policySaving={policySavingKey === channel.key}
            policyLoading={policiesLoading}
            policyError={policiesError}
            onPolicyChange={
              onChannelPolicyChange
                ? (next) => handlePolicyChange(channel.key, next)
                : undefined
            }
          />
        </div>
      ))}

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

      {/* Floor confirmation — loosening or hard-denying access needs a nod. */}
      <ConfirmDialog
        open={pendingPolicy !== null}
        title={pendingConfirmation?.title ?? ""}
        message={pendingConfirmation?.message ?? ""}
        confirmLabel={pendingConfirmation?.confirmLabel ?? "Confirm"}
        destructive={pendingConfirmation?.destructive ?? false}
        onConfirm={() => {
          if (pendingPolicy) {
            onChannelPolicyChange?.(pendingPolicy.channelKey, pendingPolicy.policy);
          }
          setPendingPolicy(null);
        }}
        onCancel={() => setPendingPolicy(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel Row
// ---------------------------------------------------------------------------

interface ChannelRowProps {
  channel: AssistantChannelState;
  assistantName: string;
  /** Trimmed assistant name with a "your assistant" fallback, for copy. */
  assistantDisplayName: string;
  pending: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSetup?: () => void;
  onDisconnect?: () => void;
  onSaveTelegramToken?: (botToken: string) => Promise<void>;
  onSaveSlackConfig?: (botToken: string, appToken: string) => void;
  slackSaveStatus?: MutationStatus;
  slackSaveError?: string | null;
  slackThreadMode?: SlackThreadMode;
  slackThreadModePending?: boolean;
  onSlackThreadModeChange?: (mode: SlackThreadMode) => void;
  onSaveTwilioCredentials?: (accountSid: string, authToken: string) => Promise<void>;
  policy?: AdmissionPolicy;
  policySaving?: boolean;
  policyLoading?: boolean;
  policyError?: boolean;
  onPolicyChange?: (policy: AdmissionPolicy) => void;
}

function ChannelRow({
  channel,
  assistantName,
  assistantDisplayName,
  pending,
  expanded,
  onToggleExpand,
  onSetup,
  onDisconnect,
  onSaveTelegramToken,
  onSaveSlackConfig,
  slackSaveStatus,
  slackSaveError,
  slackThreadMode,
  slackThreadModePending = false,
  onSlackThreadModeChange,
  onSaveTwilioCredentials,
  policy,
  policySaving = false,
  policyLoading = false,
  policyError = false,
  onPolicyChange,
}: ChannelRowProps) {
  const meta = CHANNEL_META[channel.key];
  const connected = channel.status === "ready";

  return (
    <div className="flex flex-col gap-2 py-4">
      <div className="flex items-center gap-3">
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

      {expanded ? (
        <div className={connected ? "flex flex-col gap-4" : undefined}>
          {connected && onPolicyChange ? (
            <ChannelTrustFloorSection
              assistantDisplayName={assistantDisplayName}
              policy={policy}
              saving={policySaving}
              loading={policyLoading}
              error={policyError}
              onChange={onPolicyChange}
            />
          ) : null}

          {channel.key === "telegram" ? (
            <TelegramCredentialEntry onSave={onSaveTelegramToken} />
          ) : null}

          {channel.key === "slack" ? (
            <SlackChannelCard assistantName={assistantName} connected={connected}>
              <SlackSetupWizard
                assistantName={assistantName}
                connected={connected}
                onSave={onSaveSlackConfig}
                saveStatus={slackSaveStatus}
                saveError={slackSaveError}
                threadMode={slackThreadMode}
                threadModePending={slackThreadModePending}
                onThreadModeChange={onSlackThreadModeChange}
              />
            </SlackChannelCard>
          ) : null}

          {channel.key === "phone" ? (
            <TwilioCredentialEntry onSave={onSaveTwilioCredentials} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel Trust Floor
// ---------------------------------------------------------------------------

interface ChannelTrustFloorSectionProps {
  assistantDisplayName: string;
  policy?: AdmissionPolicy;
  saving?: boolean;
  loading?: boolean;
  error?: boolean;
  onChange: (policy: AdmissionPolicy) => void;
}

function ChannelTrustFloorSection({
  assistantDisplayName,
  policy,
  saving = false,
  loading = false,
  error = false,
  onChange,
}: ChannelTrustFloorSectionProps) {
  const value = policy ?? ADMISSION_POLICY_DEFAULT;
  const descriptions = getPolicyDescriptions(assistantDisplayName);
  const options = ADMISSION_POLICY_VALUES.map((floor) => ({
    value: floor,
    label: POLICY_LABELS[floor],
    tooltip: descriptions[floor],
  }));

  return (
    <div className="flex flex-col gap-2 pl-7">
      <Typography
        as="span"
        variant="body-small-emphasised"
        className="text-[color:var(--content-secondary)]"
      >
        Who can message {assistantDisplayName}
      </Typography>
      {loading ? (
        // Hold off on rendering a concrete floor until the GET succeeds — the
        // default would otherwise misreport a channel with a stored non-default
        // (e.g. `no_one`) policy and let the user overwrite it.
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[color:var(--content-tertiary)]"
        >
          Loading…
        </Typography>
      ) : error ? (
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[color:var(--content-negative)]"
        >
          Couldn’t load this setting. Try reopening this page.
        </Typography>
      ) : (
        <>
          <div style={{ maxWidth: 280 }}>
            <Dropdown<AdmissionPolicy>
              value={value}
              onChange={onChange}
              options={options}
              disabled={saving}
              aria-label={`Who can message ${assistantDisplayName}`}
            />
          </div>
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[color:var(--content-tertiary)]"
          >
            {descriptions[value]}
          </Typography>
          {value === "trusted_contacts" ? (
            <Notice tone="info" className="max-w-lg">
              People you haven’t verified yet — even teammates in the same
              channel — can’t get through: {assistantDisplayName} lets them
              know they need to be verified and notifies you. You can verify
              people ahead of time in Contacts.
            </Notice>
          ) : null}
        </>
      )}
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
