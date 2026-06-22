import { useState } from "react";

import type { SkillInfo } from "@/domains/intelligence/skills/types";

interface SkillIconProps {
  skill: Pick<SkillInfo, "id" | "icon" | "emoji">;
  className?: string;
  fallback?: string;
}

export function SkillIcon({ skill, className, fallback = "\u{1F9E9}" }: SkillIconProps) {
  const [imgError, setImgError] = useState(false);

  if (skill.icon && !imgError) {
    return (
      <img
        src={`/assistant/skills/${skill.id}/${skill.icon}`}
        alt=""
        className={`${className} object-contain`}
        onError={() => setImgError(true)}
      />
    );
  }

  return <span className={className}>{skill.emoji ?? fallback}</span>;
}
