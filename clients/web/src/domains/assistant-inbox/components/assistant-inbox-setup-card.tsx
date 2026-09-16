import type { CSSProperties } from "react";
import { useState } from "react";

import { Button } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

const AVATAR_SIZE = 44;
const DISC_SIZE = 64;

export interface AssistantInboxSetupCardProps {
  /** Whose address this creates; the card shows their avatar. */
  assistantId: string;
  /** The assistant's handle, set during onboarding; shown, not edited. */
  handle: string;
  rootDomain: string;
  onConfirm: (draft: { prefix: string }) => void;
  /** The registration is in flight; the action holds. */
  busy?: boolean;
}

/**
 * The inbox on an entitled plan with no address yet. One decision is left,
 * the local part of the address, because onboarding already fixed the
 * handle, so that is the one field here: the handle and domain read as
 * text after the `@`. Everything is centred under the assistant's avatar,
 * and there is one way out, forward. Skipping would leave the inbox with
 * nothing to show, so the card does not offer it.
 */
export function AssistantInboxSetupCard({
  assistantId,
  handle,
  rootDomain,
  onConfirm,
  busy = false,
}: AssistantInboxSetupCardProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits, customImageUrl, accentHex } =
    useAssistantAvatar(assistantId);
  const [prefix, setPrefix] = useState("hi");

  const discStyle: CSSProperties = {
    width: DISC_SIZE,
    height: DISC_SIZE,
    ...(accentHex
      ? {
          backgroundColor: `color-mix(in oklab, ${accentHex} 28%, var(--surface-active))`,
        }
      : {}),
  };

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={t("assistantInboxSetupCard.subtitle")}
          leading={
            <span
              aria-hidden="true"
              className="flex items-center justify-center rounded-full bg-[var(--surface-active)]"
              style={discStyle}
            >
              <ChatAvatar
                components={components}
                traits={traits}
                customImageUrl={customImageUrl}
                size={AVATAR_SIZE}
              />
            </span>
          }
          footerAlign="center"
          footer={
            <Button
              variant="primary"
              disabled={!prefix || busy}
              onClick={() => onConfirm({ prefix })}
            >
              {t("assistantInboxSetupCard.getStarted")}
            </Button>
          }
        >
          <div className="flex flex-col items-center gap-2">
            <EmailAddressFields
              prefix={prefix}
              handle={handle}
              rootDomain={rootDomain}
              onPrefixChange={setPrefix}
              disabled={busy}
              autoFocus
            />
            <p className="text-center text-body-small-lighter text-[var(--content-tertiary)]">
              {t("assistantInboxSetupCard.addressPreview", {
                address: `${prefix || "hi"}@${handle}.${rootDomain}`,
              })}
            </p>
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
