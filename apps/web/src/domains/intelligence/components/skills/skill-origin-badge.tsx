import { Globe, Package, Puzzle, Terminal, User } from "lucide-react";
import { createElement } from "react";

import { Tag } from "@vellum/design-library";
import type { SkillOrigin } from "@/domains/intelligence/skills/types";

const ORIGIN_META: Record<SkillOrigin, { label: string; icon: typeof Globe }> = {
  vellum: { label: "Vellum", icon: Package },
  clawhub: { label: "Clawhub", icon: Globe },
  skillssh: { label: "skills.sh", icon: Terminal },
  custom: { label: "Custom", icon: User },
};

export function SkillOriginBadge({ origin }: { origin: SkillOrigin | string }) {
  const meta =
    origin in ORIGIN_META
      ? ORIGIN_META[origin as SkillOrigin]
      : { label: origin.replace(/-/g, " "), icon: Puzzle };

  return (
    <Tag tone="neutral" leftIcon={createElement(meta.icon)} className="capitalize">
      {meta.label}
    </Tag>
  );
}
