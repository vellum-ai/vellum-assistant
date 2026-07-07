import { type SkillInfo } from "@/domains/intelligence/skills/types";
import { ConfirmDialog } from "@vellumai/design-library";

interface SkillRemovalDialogProps {
  /** Skill awaiting removal confirmation; `null` keeps the dialog closed. */
  skill: SkillInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirm-gated removal dialog for a skill, shared by the Skills list and
 * the skill detail page. Pair with `useSkillActions`, which owns the
 * pending-removal state and the confirm/cancel handlers.
 */
export function SkillRemovalDialog({
  skill,
  onConfirm,
  onCancel,
}: SkillRemovalDialogProps) {
  return (
    <ConfirmDialog
      open={skill !== null}
      title="Remove skill"
      message={skill ? `Remove "${skill.name}" from this assistant?` : ""}
      confirmLabel="Remove"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
