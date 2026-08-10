/**
 * Structured renderer for the tools a loaded skill advertises, replacing the
 * daemon's machine-facing "## Available Tools" markdown block with a scannable
 * list (LUM-2999).
 *
 * Each tool is one row: monospace name, prose description, and its parameters
 * as `name type required?` triples. Tools contributed by a nested child skill
 * are grouped under that skill's name so a composite skill's provenance stays
 * visible.
 */

import { Typography } from "@vellumai/design-library";

import type { SkillToolParam, SkillToolSummary } from "@/domains/chat/utils/skill-activity";

/** One `name (type, required)` row under a tool. */
function ParamRow({ param }: { param: SkillToolParam }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <Typography
        variant="label-small-default"
        as="span"
        className="font-mono text-[var(--content-default)]"
      >
        {param.name}
      </Typography>
      <Typography
        variant="label-small-default"
        as="span"
        className="text-[var(--content-tertiary)]"
      >
        {param.type}
      </Typography>
      {param.required && (
        <Typography
          variant="label-small-default"
          as="span"
          className="text-[var(--system-mid-strong)]"
        >
          required
        </Typography>
      )}
      {param.description && (
        <Typography
          variant="body-small-default"
          as="span"
          className="w-full text-[var(--content-secondary)]"
        >
          {param.description}
        </Typography>
      )}
    </li>
  );
}

function SkillToolRow({ tool }: { tool: SkillToolSummary }) {
  return (
    <li className="rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-3">
      <Typography
        variant="body-small-default"
        as="span"
        className="font-mono text-[var(--content-default)]"
      >
        {tool.name}
      </Typography>
      {tool.description && (
        <Typography
          variant="body-small-default"
          as="p"
          className="mt-1 text-[var(--content-secondary)]"
        >
          {tool.description}
        </Typography>
      )}
      {tool.params.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {tool.params.map((param) => (
            <ParamRow key={param.name} param={param} />
          ))}
        </ul>
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
    <div className="flex flex-col gap-3">
      {ownTools.length > 0 && (
        <ul className="flex flex-col gap-2">
          {ownTools.map((tool) => (
            <SkillToolRow key={tool.name} tool={tool} />
          ))}
        </ul>
      )}
      {childSkills.map((skillName) => (
        <div key={skillName}>
          <Typography
            variant="label-small-default"
            as="div"
            className="mb-1.5 text-[var(--content-tertiary)]"
          >
            From {skillName}
          </Typography>
          <ul className="flex flex-col gap-2">
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
