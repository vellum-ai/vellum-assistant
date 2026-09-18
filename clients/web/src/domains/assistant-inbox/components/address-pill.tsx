import { Check, Copy } from "lucide-react";
import type { CSSProperties } from "react";

import {
  cn,
  panelItemWashStyle,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

import { AssistantEyesMark } from "@/components/avatar/assistant-eyes-mark";
import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

/** The identity pill's disc, the size the sidebar draws it. */
const DISC_SIZE = 32;

export interface AddressPillProps {
  /** Whose address this is; the pill wears their avatar and accent. */
  assistantId: string;
  address: string;
  /**
   * Make the pill a copy control: the whole pill copies the address, and
   * the trailing glyph flips to a check while `copied` holds. Omit for a
   * static pill that only shows an address.
   */
  copy?: { copied: boolean; onCopy: () => void };
  className?: string;
}

/**
 * The assistant's address drawn the way the sidebar draws the assistant:
 * the accent disc with the avatar leading, the address where the name goes,
 * on the accent wash. Used wherever the inbox shows an address as the
 * assistant's, so the address reads the same in the masthead, the setup
 * card's preview, and the upgrade card's example.
 */
export function AddressPill({
  assistantId,
  address,
  copy,
  className,
}: AddressPillProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits, customImageUrl, accentHex } =
    useAssistantAvatar(assistantId);

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

  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-active)]"
        style={discStyle}
      >
        {/* A character avatar shows as the sidebar's assistant pill shows
            it: the eyes alone on the accent disc, at their hand-tuned size.
            The whole figure scaled into the disc leaves them too small to
            read. An uploaded image has no eyes to lift out, so it fills the
            disc as it does everywhere else. */}
        {components && traits ? (
          <AssistantEyesMark assistantId={assistantId} />
        ) : (
          <ChatAvatar
            components={components}
            traits={traits}
            customImageUrl={customImageUrl}
            size={DISC_SIZE}
          />
        )}
      </span>
      <span className="min-w-0 truncate text-body-medium-default text-[var(--content-default)]">
        {address}
      </span>
    </>
  );

  const shapeClasses =
    "inline-flex max-w-full select-none items-center gap-2.5 rounded-full bg-[var(--panel-item-bg,var(--surface-active))]";

  if (!copy) {
    return (
      <div className={cn(shapeClasses, "pr-4", className)} style={pillStyle}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={copy.onCopy}
      aria-label={t("addressPill.copyAddress")}
      title={
        copy.copied ? t("addressPill.copied") : t("addressPill.copyAddress")
      }
      className={cn(
        shapeClasses,
        "group cursor-pointer pr-3",
        "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
        "transition-colors duration-150 active:scale-[0.98]",
        className,
      )}
      style={pillStyle}
    >
      {body}
      {copy.copied ? (
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
  );
}
