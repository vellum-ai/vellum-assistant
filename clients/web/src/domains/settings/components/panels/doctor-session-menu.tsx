import { ClipboardCopy, EllipsisVertical, MessageSquareText } from "lucide-react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";

import { useTranslation } from "@/i18n";

export interface DoctorSessionMenuProps {
  /**
   * Opens the feedback form. Omit where feedback has no platform to reach, so
   * the command is absent rather than present and inert.
   */
  onShareFeedback?: () => void;
  /** Copies the transcript. Omit while there is no session to copy. */
  onCopySession?: () => void;
  /** Start the menu open. For tests; the header leaves it closed. */
  defaultOpen?: boolean;
}

/**
 * The Doctor header's overflow menu: the commands that act on the session as a
 * whole, minus the one control that has to stay visible while a session runs
 * (End Session). The header is the narrowest strip in the panel and the mobile
 * shells render it at phone width, where three side-by-side labelled controls
 * wrap into each other.
 *
 * Rendered through `ActionMenu`, so the same commands arrive as a dropdown
 * under a pointer and a bottom sheet under a thumb.
 *
 * Both commands are conditional, and with neither the trigger would open on an
 * empty surface, so the component renders nothing at all in that case.
 */
export function DoctorSessionMenu({
  onShareFeedback,
  onCopySession,
  defaultOpen,
}: DoctorSessionMenuProps) {
  const { t } = useTranslation("settings");
  const title = t("doctorPanel.sessionMenu");

  if (!onShareFeedback && !onCopySession) {
    return null;
  }

  return (
    <ActionMenu.Root defaultOpen={defaultOpen}>
      <ActionMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="regular"
          // Without this a ghost icon-only button paints a filled circle on a
          // touch surface, which is the chrome the header is trying to shed.
          expandOnMobile={false}
          iconOnly={<EllipsisVertical />}
          aria-label={title}
        />
      </ActionMenu.Trigger>
      <ActionMenu.Content title={title} align="end">
        {onShareFeedback ? (
          <ActionMenu.Item
            icon={MessageSquareText}
            label={t("doctorPanel.shareFeedback")}
            onSelect={onShareFeedback}
          />
        ) : null}
        {onCopySession ? (
          <ActionMenu.Item
            icon={ClipboardCopy}
            label={t("doctorPanel.copySession")}
            onSelect={onCopySession}
          />
        ) : null}
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}
