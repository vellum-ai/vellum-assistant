import { Check, Copy } from "lucide-react";
import type { CSSProperties } from "react";

import {
  cn,
  panelItemWashStyle,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import type { InboxUsage } from "../types";

/** The identity pill's disc, the size the sidebar draws it. */
const DISC_SIZE = 32;

/** Instrument Serif, the same face the onboarding cards set their titles in. */
const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: "28px",
  fontWeight: 400,
  lineHeight: 1.15,
  letterSpacing: "0.4px",
};

export interface AssistantInboxHeaderProps {
  assistantId: string;
  assistantName: string;
  address: string;
  usage?: InboxUsage;
}

/**
 * The inbox masthead: whose inbox this is, in serif, with the line that says
 * what it holds, and under them the address drawn as the sidebar's identity
 * pill, the assistant's disc leading and the address where the name goes.
 * The whole pill is the copy control, so the address is one click to take
 * anywhere; the trailing glyph flips to a check while the copy holds. When
 * usage is known, the day's counts sit on the trailing edge so the daily
 * send limit is never a surprise.
 */
export function AssistantInboxHeader({
  assistantId,
  assistantName,
  address,
  usage,
}: AssistantInboxHeaderProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits, customImageUrl, accentHex } =
    useAssistantAvatar(assistantId);
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("assistantInboxHeader.copyFailed"),
  });

  const wash = accentHex ? panelItemWashStyle(accentHex) : null;
  const pillStyle: CustomPropertyStyle | undefined = wash
    ? {
        "--panel-item-bg": wash["--panel-item-bg"],
        "--panel-item-hover": wash["--panel-item-hover"],
      }
    : undefined;
  const discStyle: CSSProperties = {
    width: DISC_SIZE,
    height: DISC_SIZE,
    ...(accentHex ? { backgroundColor: accentHex } : {}),
  };

  return (
    <header
      data-testid="assistant-inbox-header"
      className="flex flex-wrap items-start gap-4 px-6 pb-4 pt-6"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1
            className="min-w-0 truncate text-[var(--content-emphasised)]"
            style={TITLE_STYLE}
          >
            {t("assistantInboxHeader.title", { name: assistantName })}
          </h1>
          <p className="text-body-medium-lighter text-[var(--content-secondary)]">
            {t("assistantInboxHeader.subtitle")}
          </p>
        </div>

        <button
          type="button"
          onClick={() => copy(address)}
          aria-label={t("assistantInboxHeader.copyAddress")}
          title={
            copied
              ? t("assistantInboxHeader.copied")
              : t("assistantInboxHeader.copyAddress")
          }
          className={cn(
            "group inline-flex max-w-full cursor-pointer select-none items-center gap-2.5 self-start rounded-full pr-3",
            "bg-[var(--panel-item-bg,var(--surface-active))]",
            "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
            "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
            "transition-colors duration-150 active:scale-[0.98]",
          )}
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
            {address}
          </span>
          {copied ? (
            <Check
              className="size-3.5 shrink-0 text-[var(--system-positive-strong)]"
              aria-hidden="true"
            />
          ) : (
            <Copy
              className="size-3.5 shrink-0 text-[var(--content-tertiary)] transition-colors group-hover:text-[var(--content-secondary)]"
              aria-hidden="true"
            />
          )}
        </button>
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
