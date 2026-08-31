import { ConfirmDialog } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

interface SkillRemovalDialogProps {
  /**
   * Name of the skill awaiting removal confirmation; `null` keeps the dialog
   * closed.
   */
  skillName: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm-gated removal dialog for a skill, shared by the Skills list, the
 * skill detail page, and the chat skill-detail panel — one place for the
 * removal copy. Takes primitives so any surface with a skill name can render
 * it; the caller owns the pending-removal state and the confirm/cancel
 * handlers (e.g. `useSkillActions` on the intelligence surfaces).
 */
export function SkillRemovalDialog({
  skillName,
  onConfirm,
  onCancel,
}: SkillRemovalDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={skillName !== null}
      title={t("skillRemovalDialog.title")}
      message={
        skillName
          ? t("skillRemovalDialog.message", { name: skillName })
          : ""
      }
      confirmLabel={t("skillRemovalDialog.remove")}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
