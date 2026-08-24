/**
 * One assistant in the switcher's expanded card (Figma 7984:9239): the full
 * avatar beside the name, with the current entry carrying a positive check
 * inline after its label and the card's collapse control in its trailing
 * slot. Presentational: the switcher decides what selecting a row does.
 */

import { Check, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PanelItem, type CustomPropertyStyle } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

/* The 32px avatar outgrows the icon the row's default gap was tuned for. */
const ROW_STYLE: CustomPropertyStyle = { "--panel-item-gap": "8px" };

interface AssistantSwitcherRowProps {
  assistantId: string | null;
  name: string;
  isCurrent?: boolean;
  disabled?: boolean;
  /** A switch to this row is in flight; shows a spinner beside the name. */
  switching?: boolean;
  /**
   * This assistant's own avatar-state-manifest capability, resolved from
   * ITS version: a sibling can run an older runtime than the active
   * assistant the default gate reads. `undefined` keeps the active gate
   * (the current row).
   */
  supportsAvatarManifest?: boolean;
  /**
   * Whether this assistant's avatar can be fetched at all: a sibling
   * behind a transport that cannot be addressed independently must not be
   * asked, or the single active connection answers with the wrong
   * assistant's avatar. `false` renders the fallback avatar.
   */
  avatarEnabled?: boolean;
  trailingAction?: ReactNode;
  onSelect: () => void;
}

export function AssistantSwitcherRow({
  assistantId,
  name,
  isCurrent = false,
  disabled = false,
  switching = false,
  supportsAvatarManifest,
  avatarEnabled = true,
  trailingAction,
  onSelect,
}: AssistantSwitcherRowProps) {
  const { t } = useTranslation("chat");
  const { components, traits, customImageUrl } = useAssistantAvatar(
    assistantId,
    { supportsManifest: supportsAvatarManifest, enabled: avatarEnabled },
  );

  const label = isCurrent ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{name}</span>
      <Check
        aria-hidden
        className="size-4 shrink-0 text-[var(--system-positive-strong)]"
      />
    </span>
  ) : (
    name
  );

  return (
    <PanelItem
      shape="row"
      className="h-auto rounded-[12px] text-[var(--content-default)]"
      leadingSlot={
        <ChatAvatar
          components={components}
          traits={traits}
          customImageUrl={customImageUrl}
          size={32}
        />
      }
      label={label}
      aria-label={
        isCurrent
          ? t("assistantSwitcher.currentAssistant", { name })
          : t("assistantSwitcher.switchTo", { name })
      }
      onSelect={onSelect}
      disabled={disabled}
      badgeBare
      badge={
        switching ? (
          <Loader2
            aria-hidden
            className="size-4 animate-spin text-[var(--content-tertiary)]"
          />
        ) : undefined
      }
      trailingAction={trailingAction}
      style={ROW_STYLE}
    />
  );
}
