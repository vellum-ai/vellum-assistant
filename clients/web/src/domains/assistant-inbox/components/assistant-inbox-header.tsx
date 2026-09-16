import { Check, Copy } from "lucide-react";
import type { CSSProperties } from "react";

import { Button } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import type { InboxUsage } from "../types";

const AVATAR_SIZE = 40;
const DISC_SIZE = 56;

/** Instrument Serif, the same face the onboarding cards set their titles in. */
const ADDRESS_STYLE: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: "26px",
  fontWeight: 400,
  lineHeight: 1.15,
  letterSpacing: "0.3px",
};

export interface AssistantInboxHeaderProps {
  assistantId: string;
  address: string;
  usage?: InboxUsage;
}

/**
 * The inbox masthead: the assistant's avatar on a disc washed in its accent,
 * the address it answers to in serif with a one-click copy beside it, and
 * the line that says whose mail this is. When usage is known, the day's
 * counts sit on the trailing edge so the daily send limit is never a
 * surprise.
 */
export function AssistantInboxHeader({
  assistantId,
  address,
  usage,
}: AssistantInboxHeaderProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits, customImageUrl, accentHex } =
    useAssistantAvatar(assistantId);
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("assistantInboxHeader.copyFailed"),
  });

  const washStyle: CSSProperties | undefined = accentHex
    ? {
        background: `linear-gradient(to bottom, color-mix(in oklab, ${accentHex} 16%, transparent), transparent)`,
      }
    : undefined;
  const discStyle: CSSProperties = accentHex
    ? {
        width: DISC_SIZE,
        height: DISC_SIZE,
        backgroundColor: `color-mix(in oklab, ${accentHex} 28%, var(--surface-active))`,
      }
    : { width: DISC_SIZE, height: DISC_SIZE };

  return (
    <header
      data-testid="assistant-inbox-header"
      className="flex flex-wrap items-center gap-4 px-6 pb-4 pt-6"
      style={washStyle}
    >
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

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h1
            className="min-w-0 truncate text-[var(--content-emphasised)]"
            style={ADDRESS_STYLE}
          >
            {address}
          </h1>
          <Button
            variant="ghost"
            size="compact"
            iconOnly={copied ? <Check /> : <Copy />}
            aria-label={t("assistantInboxHeader.copyAddress")}
            tooltip={
              copied
                ? t("assistantInboxHeader.copied")
                : t("assistantInboxHeader.copyAddress")
            }
            onClick={() => copy(address)}
            className={copied ? "text-[var(--system-positive-strong)]" : ""}
          />
        </div>
        <p className="text-body-medium-lighter text-[var(--content-secondary)]">
          {t("assistantInboxHeader.subtitle")}
        </p>
      </div>

      {usage ? (
        <p className="shrink-0 text-body-small-lighter text-[var(--content-tertiary)]">
          {t("assistantInboxHeader.usage", {
            sent: usage.sentToday,
            received: usage.receivedToday,
          })}
        </p>
      ) : null}
    </header>
  );
}
