
import { Globe, Package, Puzzle, Terminal, User } from "lucide-react";
import { createElement } from "react";

import { Tag } from "@vellum/design-library/components/tag";
import type { SkillOrigin } from "@/lib/skills/types.js";

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

  // TODO: Skill origins use brand colors (e.g. #0E9B8B for Clawhub) that
  // don't map onto the Tag primitive's 4 tones. The leading icon carries
  // the distinction; the chip is rendered with the neutral tone.
  return (
    <Tag tone="neutral" leftIcon={createElement(meta.icon)} className="capitalize">
      {meta.label}
    </Tag>
  );
}
