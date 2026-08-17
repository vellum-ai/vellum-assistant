import { Box, Brain, Globe, Puzzle, Terminal, User } from "lucide-react";
import { createElement } from "react";

import type { SkillOrigin } from "@/domains/intelligence/skills/types";
import { useTranslation } from "@/i18n";
import { Tag } from "@vellumai/design-library";

const ORIGIN_ICON: Record<SkillOrigin, typeof Globe> = {
  vellum: Box,
  clawhub: Globe,
  skillssh: Terminal,
  custom: User,
  "assistant-memory": Brain,
};

/** `vellum`, `clawhub`, and `skills.sh` are brand/product names, never translated. */
function brandOrCatalogLabel(
  origin: SkillOrigin,
  t: (key: "skillOriginBadge.custom" | "skillOriginBadge.assistantMemory") => string,
): string {
  switch (origin) {
    case "vellum":
      return "Vellum";
    case "clawhub":
      return "Clawhub";
    case "skillssh":
      return "skills.sh";
    case "custom":
      return t("skillOriginBadge.custom");
    case "assistant-memory":
      return t("skillOriginBadge.assistantMemory");
  }
}

export function SkillOriginBadge({ origin }: { origin: SkillOrigin | string }) {
  const { t } = useTranslation("intelligence");
  const meta =
    origin in ORIGIN_ICON
      ? {
          label: brandOrCatalogLabel(origin as SkillOrigin, t),
          icon: ORIGIN_ICON[origin as SkillOrigin],
        }
      : { label: origin.replace(/-/g, " "), icon: Puzzle };

  return (
    <Tag
      tone="neutral"
      leftIcon={createElement(meta.icon)}
      className="capitalize"
    >
      {meta.label}
    </Tag>
  );
}
