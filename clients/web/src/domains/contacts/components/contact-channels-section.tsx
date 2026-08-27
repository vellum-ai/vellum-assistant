import {
  Bot,
  CheckCircle,
  Hash,
  HelpCircle,
  Link2,
  Mail,
  MessageSquare,
  Phone,
  Send,
} from "lucide-react";
import { createElement, useId, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

import {
  isVerifiedContactChannel,
  LINKABLE_CHANNEL_IDS,
} from "@/domains/contacts/channel-linking";
import type {
  ChannelInfo,
  ContactChannelPayload,
} from "@/domains/contacts/types";
import { useTranslation } from "@/i18n";
import { getChannelBrandMark } from "@/utils/channel-presentation";

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

/**
 * Manual guardian attest on Contacts (the Verify me button).
 *
 * `supportsVerification` is the outbound challenge flow (voice/DM code).
 * Plugin channels have no challenge, but they still use the same one-click
 * attest Phone already has on this page.
 */
export function isPluginChannel(info: ChannelInfo): boolean {
  return typeof info.source === "string" && info.source.startsWith("plugin:");
}

export function offersManualVerify(info: ChannelInfo): boolean {
  return info.supportsVerification || isPluginChannel(info);
}

export function hasVerifiableAddress(
  existing: ContactChannelPayload | undefined,
): boolean {
  return Boolean(existing?.address?.trim());
}

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

  const verified = existing != null && isVerifiedContactChannel(existing);

  if (verified) {
    return { kind: "verified" };
  }
  // Don't offer to verify a blocked channel: verifying flips it to active and clears the ban.
  if (existing?.status === "blocked") {
    return { kind: "none" };
  }
  if (existing && existing.status !== "revoked") {
    return { kind: "unverified" };
  }
  // Plugin channels have no outbound challenge conversation. Contacts
  // attests them in-place, including when no row exists yet.
  if (isPluginChannel(info)) {
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
      source: "default",
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
  /**
   * The channel list could not be fetched, so an empty list means unknown
   * rather than none. Rendered as a notice, since the two are indistinguishable
   * otherwise and only one of them is the assistant's fault.
   */
  channelsLoadFailed?: boolean;
  a2aEnabled?: boolean;
  setupLabel?: string;
  verifyLoading?: boolean;
  verifySubject?: "self" | "contact";
  onSetupChannel?: (type: string) => void;
  /**
   * `address` is set when the row has no identifier yet. The page upserts
   * that address and then attests it.
   */
  onVerifyChannel?: (type: string, address?: string) => void;
  onRevokeChannel?: (channelId: string, type: string) => void;
  /**
   * Opens the roster picker for a linkable channel row (see
   * `LINKABLE_CHANNEL_IDS`). When provided, unlinked linkable rows render
   * "Link account" as their primary action with Invite as the secondary.
   * Non-linkable rows are unaffected.
   */
  onLinkAccount?: (channelId: string) => void;
}

function ChannelIcon({
  channelId,
  name,
  className,
  style,
}: {
  channelId: string;
  name: string;
  className?: string;
  style?: CSSProperties;
}) {
  const brand = getChannelBrandMark(channelId);
  if (brand) {
    // Same static-component treatment the plugin glyph uses: chosen from a
    // module-level map rather than constructed here. Sized explicitly as well
    // as by class, since a brand svg draws its own dimensions where the lucide
    // icons below take theirs from the class alone.
    return createElement(brand, { size: 16, className, style });
  }
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
  channelsLoadFailed,
  a2aEnabled,
  setupLabel,
  verifyLoading,
  verifySubject = "self",
  onSetupChannel,
  onVerifyChannel,
  onRevokeChannel,
  onLinkAccount,
}: ContactChannelsSectionProps) {
  const { t } = useTranslation("contacts");
  const [verifyPending, setVerifyPending] = useState<{
    info: ChannelInfo;
    existing: ContactChannelPayload | undefined;
  } | null>(null);
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

  const handleVerifyConfirm = (address?: string) => {
    if (!verifyPending) {
      return;
    }
    onVerifyChannel?.(verifyPending.info.id, address);
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
        {channelsLoadFailed && (
          <div
            className="px-1 py-2 text-sm"
            style={{ color: "var(--content-secondary)" }}
            role="status"
          >
            {t("contactChannelsSection.loadFailed")}
          </div>
        )}
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
                setupLabel={
                  setupLabel ?? t("contactChannelsSection.setupDefault")
                }
                verifyLoading={verifyLoading}
                onSetup={
                  onSetupChannel ? () => onSetupChannel(info.id) : undefined
                }
                onVerify={
                  onVerifyChannel && offersManualVerify(info)
                    ? () => setVerifyPending({ info, existing })
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
                onLinkAccount={
                  onLinkAccount && LINKABLE_CHANNEL_IDS.has(info.id)
                    ? () => onLinkAccount(info.id)
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>

      {verifyPending ? (
        <VerifyChannelDialog
          info={verifyPending.info}
          existing={verifyPending.existing}
          verifySubject={verifySubject}
          onConfirm={handleVerifyConfirm}
          onCancel={() => setVerifyPending(null)}
        />
      ) : null}

      {revokePending && (
        <ConfirmDialog
          open={true}
          title={t("contactChannelsSection.revokeConfirmTitle", {
            channel: revokePending.channel.label,
          })}
          message={t("contactChannelsSection.revokeConfirmMessage")}
          confirmLabel={t("actions.revoke")}
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
  onLinkAccount?: () => void;
}

function ChannelRow({
  info,
  existing,
  setupLabel,
  verifyLoading,
  onSetup,
  onVerify,
  onRevoke,
  onLinkAccount,
}: ChannelRowProps) {
  const { t } = useTranslation("contacts");
  const actionState = getChannelActionState(info, existing);

  return (
    <div className="flex items-center gap-3 py-4">
      <ChannelIcon
        channelId={info.id}
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
              {t("channelStatus.connected")}
            </span>
            {onRevoke ? (
              <Button variant="danger" onClick={onRevoke}>
                {t("actions.revoke")}
              </Button>
            ) : null}
          </>
        ) : actionState.kind === "verified" ? (
          <>
            <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md whitespace-nowrap select-none text-body-small-emphasised leading-none bg-[var(--content-default)] text-[var(--surface-base)]">
              <CheckCircle className="h-3 w-3" />
              {t("channelStatus.verified")}
            </span>
            {onRevoke ? (
              <Button variant="danger" onClick={onRevoke}>
                {t("actions.revoke")}
              </Button>
            ) : null}
          </>
        ) : actionState.kind === "unverified" ? (
          <Button
            variant="outlined"
            onClick={onVerify}
            disabled={!onVerify || verifyLoading}
          >
            {verifyLoading ? t("actions.verifying") : t("actions.verify")}
          </Button>
        ) : actionState.kind === "setup" ? (
          info.id === "a2a" ? null : (
            <>
              {onLinkAccount ? (
                <Button onClick={onLinkAccount}>
                  <Link2 className="h-3.5 w-3.5" />
                  {t("contactChannelsSection.linkAccount")}
                </Button>
              ) : null}
              <Button variant="outlined" onClick={onSetup} disabled={!onSetup}>
                {setupLabel}
              </Button>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

interface VerifyChannelDialogProps {
  info: ChannelInfo;
  existing: ContactChannelPayload | undefined;
  verifySubject: "self" | "contact";
  onConfirm: (address?: string) => void;
  onCancel: () => void;
}

function VerifyChannelDialog({
  info,
  existing,
  verifySubject,
  onConfirm,
  onCancel,
}: VerifyChannelDialogProps) {
  const { t } = useTranslation("contacts");
  const knownAddress = existing?.address?.trim() ?? "";
  const [address, setAddress] = useState(knownAddress);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const addressFieldId = useId();
  const trimmedAddress = address.trim();

  if (hasVerifiableAddress(existing)) {
    return (
      <ConfirmDialog
        open={true}
        title={t("contactChannelsSection.verifyConfirmTitle", {
          channel: info.label,
        })}
        message={
          verifySubject === "contact"
            ? t("contactChannelsSection.verifyConfirmMessageContact", {
                channel: info.label,
              })
            : t("contactChannelsSection.verifyConfirmMessageGuardian", {
                channel: info.label,
              })
        }
        confirmLabel={t("actions.verify")}
        onConfirm={() => {
          onConfirm();
        }}
        onCancel={onCancel}
      />
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmedAddress.length === 0) {
      return;
    }
    onConfirm(trimmedAddress);
  };

  return (
    <Modal.Root
      open={true}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          addressInputRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      >
        <form className="flex flex-col" onSubmit={handleSubmit}>
          <Modal.Header>
            <Modal.Title>
              {t("contactChannelsSection.verifyConfirmTitle", {
                channel: info.label,
              })}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <Modal.Description>
              {verifySubject === "contact"
                ? t("contactChannelsSection.verifyAddressMessageContact", {
                    channel: info.label,
                  })
                : t("contactChannelsSection.verifyAddressMessageGuardian", {
                    channel: info.label,
                  })}
            </Modal.Description>
            <Input
              ref={addressInputRef}
              id={addressFieldId}
              label={t("contactChannelsSection.verifyAddressLabel")}
              type="text"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
              }}
              placeholder={t("contactChannelsSection.verifyAddressPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outlined" type="button" onClick={onCancel}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={trimmedAddress.length === 0}>
              {t("actions.verify")}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}
