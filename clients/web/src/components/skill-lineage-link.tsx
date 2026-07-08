/**
 * Quiet "Learned from this conversation" link shown on skill detail surfaces
 * (skill detail page, chat skill sidepanel) for skills the assistant authored
 * from a conversation. Renders only for `assistant-memory` skills whose
 * install-meta recorded a source conversation — callers pass whatever skill
 * shape they have and the gate lives here.
 */

import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { cn } from "@/utils/misc";
import { routes } from "@/utils/routes";

interface SkillLineageLinkProps {
  /**
   * Origin plus the lineage id when known. The generated skill detail union
   * and `SkillInfo` both satisfy this shape without narrowing.
   */
  skill: { origin: string; sourceConversationId?: string | null };
  className?: string;
  /** Invoked on click before navigation (e.g. to close the hosting panel). */
  onNavigate?: () => void;
}

export function SkillLineageLink({
  skill,
  className,
  onNavigate,
}: SkillLineageLinkProps) {
  if (skill.origin !== "assistant-memory" || !skill.sourceConversationId) {
    return null;
  }

  return (
    <Link
      to={routes.conversation(skill.sourceConversationId)}
      onClick={onNavigate}
      className={cn(
        "inline-flex w-fit items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] hover:underline",
        className,
      )}
    >
      Learned from this conversation
      <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </Link>
  );
}
