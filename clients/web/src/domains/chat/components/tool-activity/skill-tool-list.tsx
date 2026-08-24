/**
 * The tools a loaded skill advertises, replacing the daemon's machine-facing
 * "## Available Tools" markdown block with a scannable list (LUM-2999).
 *
 * Deliberately minimal: a tool's name and one-line description answer the only
 * question this panel exists to answer — what can the assistant do now that it
 * couldn't a moment ago. The manifest's parameter schemas are model-facing API
 * surface (the user is never going to call `app_create(name, template)`
 * themselves), so they're parsed but not rendered; showing them tripled each
 * card's height for detail nobody acts on.
 *
 * Tools contributed by a nested child skill are grouped under that skill's name
 * so a composite skill's provenance stays visible.
 */

import { Typography } from "@vellumai/design-library";

import type { SkillToolSummary } from "@/domains/chat/utils/skill-activity";
import { useTranslation } from "@/i18n";

function SkillToolRow({ tool }: { tool: SkillToolSummary }) {
  return (
    <li>
      <Typography
        variant="body-medium-default"
        as="div"
        className="font-mono leading-5 text-[var(--content-default)]"
      >
        {tool.name}
      </Typography>
      {tool.description && (
        <Typography
          variant="body-small-lighter"
          as="p"
          className="mt-1 text-[var(--content-secondary)]"
        >
          {tool.description}
        </Typography>
      )}
    </li>
  );
}

/**
 * Render `tools` grouped by contributing skill. The parent skill's own tools
 * (`fromSkill === null`) render first and ungrouped; each child skill's tools
 * follow under a "From <skill>" label.
 */
export function SkillToolList({ tools }: { tools: SkillToolSummary[] }) {
  const { t } = useTranslation("chat");
  if (tools.length === 0) {
    return null;
  }

  const ownTools = tools.filter((tool) => tool.fromSkill === null);
  const childSkills = [
    ...new Set(
      tools
        .map((tool) => tool.fromSkill)
        .filter((name): name is string => name !== null),
    ),
  ];

  return (
    <div className="flex flex-col gap-5">
      {ownTools.length > 0 && (
        <ul className="flex flex-col gap-4">
          {ownTools.map((tool) => (
            <SkillToolRow key={tool.name} tool={tool} />
          ))}
        </ul>
      )}
      {childSkills.map((skillName) => (
        <div key={skillName}>
          <Typography
            variant="body-small-lighter"
            as="div"
            className="mb-3 text-[var(--content-tertiary)]"
          >
            {t("skillToolList.fromSkill", { name: skillName })}
          </Typography>
          <ul className="flex flex-col gap-4">
            {tools
              .filter((tool) => tool.fromSkill === skillName)
              .map((tool) => (
                <SkillToolRow key={`${skillName}:${tool.name}`} tool={tool} />
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
