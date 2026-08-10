/**
 * A skill's glyph: its packaged icon file when it ships one, else its emoji,
 * else a neutral fallback. Lives here rather than under `domains/intelligence/`
 * because the chat drawer renders it too (the `skill_load` activity panel), and
 * a domain may not import another domain's internals.
 *
 * The prop is typed structurally so this component doesn't depend on any
 * domain's skill model — `SkillInfo` and the generated daemon skill both
 * satisfy it.
 */

import { useState } from "react";

interface SkillIconProps {
  skill: { id: string; icon?: string; emoji?: string };
  className?: string;
  fallback?: string;
}

export function SkillIcon({
  skill,
  className,
  fallback = "\u{1F9E9}",
}: SkillIconProps) {
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
