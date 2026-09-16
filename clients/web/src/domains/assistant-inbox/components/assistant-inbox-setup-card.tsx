import type { CSSProperties } from "react";
import { useState } from "react";

import { Button, panelItemWashStyle } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

/** The identity pill's disc, the size the sidebar draws it. */
const DISC_SIZE = 32;

export interface AssistantInboxSetupCardProps {
  /** Whose address this creates; the preview pill shows their avatar. */
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
 * handle, so that is the one field: the handle and domain read as text
 * after the `@`. Beneath it the address the field will produce is drawn as
 * the sidebar's identity pill, the assistant's disc leading and the address
 * where the name usually goes, so the preview reads as the assistant, not
 * as a caption. There is one way out, forward: skipping would leave the
 * inbox with nothing to show.
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

  const wash = accentHex ? panelItemWashStyle(accentHex) : null;
  const pillStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-bg"]) }
    : {};
  const discStyle: CSSProperties = {
    width: DISC_SIZE,
    height: DISC_SIZE,
    ...(accentHex ? { backgroundColor: accentHex } : {}),
  };

  return (
    <AssistantInboxShell>
      <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <InboxCard
          title={t("assistantInboxSetupCard.title")}
          subtitle={t("assistantInboxSetupCard.subtitle")}
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
          <div className="flex flex-col items-center gap-4">
            <EmailAddressFields
              prefix={prefix}
              handle={handle}
              rootDomain={rootDomain}
              onPrefixChange={setPrefix}
              disabled={busy}
              autoFocus
            />
            <div
              className="inline-flex max-w-full items-center gap-2.5 rounded-full bg-[var(--surface-active)] pr-4"
              style={pillStyle}
            >
              <span
                aria-hidden="true"
                className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-active)]"
                style={discStyle}
              >
                <ChatAvatar
                  components={components}
                  traits={traits}
                  customImageUrl={customImageUrl}
                  size={DISC_SIZE}
                />
              </span>
              <span className="min-w-0 truncate text-body-medium-default text-[var(--content-default)]">
                {prefix || t("emailAddressFields.prefixPlaceholder")}@{handle}.
                {rootDomain}
              </span>
            </div>
          </div>
        </InboxCard>
      </div>
    </AssistantInboxShell>
  );
}
