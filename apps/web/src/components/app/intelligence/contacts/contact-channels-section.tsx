
import {
  Bot,
  CheckCircle,
  Hash,
  HelpCircle,
  Mail,
  MessageSquare,
  Phone,
  Send,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import type { ChannelInfo, ContactChannelPayload } from "@/lib/contacts/types.js";

/** Discriminated union describing what action/badge to render for a channel row. */
export type ChannelActionState =
  | { kind: "connected" }
  | { kind: "verified" }
  | { kind: "unverified" }
  | { kind: "setup" }
  | { kind: "none" };

/**
 * Determine what action/badge to show for a given channel and its optional
 * existing contact-channel entry. Extracted as a pure helper for testability.
 */
export function getChannelActionState(
  info: ChannelInfo,
  existing: ContactChannelPayload | undefined,
): ChannelActionState {
  const isA2A = info.id === "a2a";

  if (isA2A) {
    if (existing && existing.status !== "revoked") {
      return { kind: "connected" };
    }
    return { kind: "setup" };
  }

  const verified =
    existing?.status === "verified" ||
    (existing?.status === "active" && existing?.verifiedAt != null);

  if (verified) {
    return { kind: "verified" };
  }
  if (existing && existing.status !== "revoked") {
    return { kind: "unverified" };
  }
  return { kind: "setup" };
}

/**
 * Build the ordered list of visible channel rows from the available channels
 * and the contact's existing channels. Filters out A2A channels when the
 * feature flag is off.
 */
export function buildVisibleChannels(
  availableChannels: ChannelInfo[] | undefined,
  contactChannels: ContactChannelPayload[],
  a2aEnabled?: boolean,
): ChannelInfo[] {
  const visibleChannels: ChannelInfo[] = [];
  const seen = new Set<string>();
  if (availableChannels) {
    for (const info of availableChannels) {
      if (info.id === "a2a" && !a2aEnabled) {
        continue;
      }
      visibleChannels.push(info);
      seen.add(info.id);
    }
  }
  for (const ch of contactChannels) {
    if (ch.status === "revoked" || seen.has(ch.type)) {
      continue;
    }
    if (ch.type === "a2a" && !a2aEnabled) {
      continue;
    }
    visibleChannels.push({
      id: ch.type,
      label: ch.type.charAt(0).toUpperCase() + ch.type.slice(1),
      subtitle: "",
      icon: "help-circle",
      supportsVerification: false,
      setupMessages: { guardian: "", contact: "" },
    });
    seen.add(ch.type);
  }
  return visibleChannels;
}

interface ContactChannelsSectionProps {
  contactChannels: ContactChannelPayload[];
  /**
   * Display metadata for every channel the assistant supports, in display
   * order. Sourced from the gateway's `/v1/channels/available` endpoint —
   * the frontend must not hardcode this set. Channels present here render
   * a row whether or not the contact has them configured; channels the
   * contact has that aren't here still render so the user can revoke.
   */
  availableChannels?: ChannelInfo[];
  /** Whether the A2A channel feature flag is enabled. */
  a2aEnabled?: boolean;
  setupLabel?: string;
  /** True while a verify mutation is in flight — disables the Verify button. */
  verifyLoading?: boolean;
  onSetupChannel?: (type: string) => void;
  onVerifyChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
}

/**
 * Render the lucide icon named by the gateway. The gateway emits kebab-case
 * lucide names; the switch is the contract between the two sides. An
 * unrecognized name falls back to a help-circle so a new channel rollout
 * never produces a blank card.
 */
function ChannelIcon({
  name,
  className,
  style,
}: {
  name: string;
  className?: string;
  style?: CSSProperties;
}) {
  switch (name) {
    case "bot":
      return <Bot className={className} style={style} />;
    case "hash":
      return <Hash className={className} style={style} />;
    case "send":
      return <Send className={className} style={style} />;
    case "phone":
      return <Phone className={className} style={style} />;
    case "mail":
      return <Mail className={className} style={style} />;
    case "message-square":
      return <MessageSquare className={className} style={style} />;
    default:
      return <HelpCircle className={className} style={style} />;
  }
}

export function ContactChannelsSection({
  contactChannels,
  availableChannels,
  a2aEnabled,
  setupLabel = "Invite",
  verifyLoading,
  onSetupChannel,
  onVerifyChannel,
  onRevokeChannel,
}: ContactChannelsSectionProps) {
  const [verifyPending, setVerifyPending] = useState<ChannelInfo | null>(null);
  const [revokePending, setRevokePending] = useState<{
    channelId: string;
    channel: ChannelInfo;
  } | null>(null);

  const channelsByType = new Map<string, ContactChannelPayload>();
  for (const ch of contactChannels) {
    if (ch.status === "revoked") {
      continue;
    }
    if (!channelsByType.has(ch.type)) {
      channelsByType.set(ch.type, ch);
    }
  }

  const handleVerifyConfirm = () => {
    if (!verifyPending) {
      return;
    }
    onVerifyChannel?.(verifyPending.id);
    setVerifyPending(null);
  };

  const visibleChannels = buildVisibleChannels(
    availableChannels,
    contactChannels,
    a2aEnabled,
  );

  return (
    <>
      <div className="flex flex-col">
        {visibleChannels.map((info, index) => {
          const existing = channelsByType.get(info.id);
          return (
            <div key={info.id}>
              {index > 0 && (
                <div
                  className="border-t"
                  style={{ borderColor: "var(--border-base)" }}
                />
              )}
              <ChannelRow
                info={info}
                existing={existing}
                setupLabel={setupLabel}
                verifyLoading={verifyLoading}
                onSetup={
                  onSetupChannel ? () => onSetupChannel(info.id) : undefined
                }
                onVerify={
                  onVerifyChannel && info.supportsVerification
                    ? () => setVerifyPending(info)
                    : undefined
                }
                onRevoke={
                  onRevokeChannel && existing
                    ? () =>
                        setRevokePending({
                          channelId: existing.id,
                          channel: info,
                        })
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>

      {verifyPending && (
        <ConfirmDialog
          open={true}
          title={`Verify ${verifyPending.label}`}
          message={`This will mark your ${verifyPending.label} channel as verified. Your assistant will recognize you when you reach out from it.`}
          confirmLabel="Verify"
          onConfirm={handleVerifyConfirm}
          onCancel={() => setVerifyPending(null)}
        />
      )}

      {revokePending && (
        <ConfirmDialog
          open={true}
          title={`Revoke ${revokePending.channel.label}`}
          message="This will disconnect the verified channel. The contact will need to re-verify to use this channel again."
          confirmLabel="Revoke"
          destructive
          onConfirm={() => {
            onRevokeChannel?.(
              revokePending.channelId,
              revokePending.channel.id,
            );
            setRevokePending(null);
          }}
          onCancel={() => setRevokePending(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ChannelRowProps {
  info: ChannelInfo;
  existing: ContactChannelPayload | undefined;
  setupLabel: string;
  verifyLoading?: boolean;
  onSetup?: () => void;
  onVerify?: () => void;
  onRevoke?: () => void;
}

function ChannelRow({
  info,
  existing,
  setupLabel,
  verifyLoading,
  onSetup,
  onVerify,
  onRevoke,
}: ChannelRowProps) {
  const actionState = getChannelActionState(info, existing);

  return (
    <div className="flex items-center gap-3 py-4">
      <ChannelIcon
        name={info.icon}
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--content-secondary)" }}
      />
      <span
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {info.label}
      </span>
      {existing?.address ? (
        <span
          className="truncate text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {existing.address}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {actionState.kind === "connected" ? (
          <>
            <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
              <CheckCircle className="h-3 w-3" />
              Connected
            </span>
            {onRevoke ? (
              <Button variant="danger" onClick={onRevoke}>
                Revoke
              </Button>
            ) : null}
          </>
        ) : actionState.kind === "verified" ? (
          <>
            <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
              <CheckCircle className="h-3 w-3" />
              Verified
            </span>
            {onRevoke ? (
              <Button variant="danger" onClick={onRevoke}>
                Revoke
              </Button>
            ) : null}
          </>
        ) : actionState.kind === "unverified" ? (
          <Button
            variant="outlined"
            onClick={onVerify}
            disabled={!onVerify || verifyLoading}
          >
            {verifyLoading ? "Verifying…" : "Verify"}
          </Button>
        ) : actionState.kind === "setup" ? (
          <Button
            variant="outlined"
            onClick={onSetup}
            disabled={!onSetup}
          >
            {info.id === "a2a" ? "Connect" : setupLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
