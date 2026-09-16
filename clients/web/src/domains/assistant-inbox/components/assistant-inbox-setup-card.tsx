import type { CSSProperties } from "react";
import { useState } from "react";

import { Button, panelItemWashStyle } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";
import { EmailAddressFields } from "./email-address-fields";
import { InboxCard } from "./inbox-card";

const AVATAR_SIZE = 28;
const DISC_SIZE = 36;

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
 * text after the `@`, with the assistant's avatar leading the line, since
 * the address is theirs. The line sits on a panel washed in the assistant's
 * accent, the same wash the New Chat pill wears. There is one way out,
 * forward: skipping would leave the inbox with nothing to show.
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
  const panelStyle: CSSProperties = wash
    ? { backgroundColor: String(wash["--panel-item-bg"]) }
    : {};
  const discStyle: CSSProperties = {
    width: DISC_SIZE,
    height: DISC_SIZE,
    ...(wash ? { backgroundColor: String(wash["--panel-item-hover"]) } : {}),
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
          <div
            className="flex flex-col items-center gap-3 rounded-xl bg-[var(--surface-sunken)] px-5 py-5"
            style={panelStyle}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-active)]"
                style={discStyle}
              >
                <ChatAvatar
                  components={components}
                  traits={traits}
                  customImageUrl={customImageUrl}
                  size={AVATAR_SIZE}
                />
              </span>
              <EmailAddressFields
                prefix={prefix}
                handle={handle}
                rootDomain={rootDomain}
                onPrefixChange={setPrefix}
                disabled={busy}
                autoFocus
              />
            </div>
            <p className="text-center text-body-small-lighter text-[var(--content-secondary)]">
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
