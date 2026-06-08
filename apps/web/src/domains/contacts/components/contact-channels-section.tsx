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

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";

import type {
    ChannelInfo,
    ContactChannelPayload,
} from "@/domains/contacts/types";

const KNOWN_CHANNEL_IDS: ReadonlySet<string> = new Set<ChannelInfo["id"]>([
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
]);

function isKnownChannelId(value: string): value is ChannelInfo["id"] {
  return KNOWN_CHANNEL_IDS.has(value);
}

/** Discriminated union describing what action/badge to render for a channel row. */
export type ChannelActionState =
  | { kind: "connected" }
  | { kind: "verified" }
  | { kind: "unverified" }
  | { kind: "setup" }
  | { kind: "none" };

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
    if (!isKnownChannelId(ch.type)) {
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
  availableChannels?: ChannelInfo[];
  a2aEnabled?: boolean;
  setupLabel?: string;
  verifyLoading?: boolean;
  onSetupChannel?: (type: string) => void;
  onVerifyChannel?: (type: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
}

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
          info.id === "a2a" ? null : (
            <Button
              variant="outlined"
              onClick={onSetup}
              disabled={!onSetup}
            >
              {setupLabel}
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}
