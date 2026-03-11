import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { skillFlagKey } from "../../config/skill-state.js";
import type { SkillSummary } from "../../config/skills.js";
import { loadSkillBySelector, loadSkillCatalog } from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import {
  indexCatalogById,
  validateIncludes,
} from "../../skills/include-graph.js";
import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { getLogger } from "../../util/logger.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("skill-load");

export class SkillLoadTool implements Tool {
  name = "skill_load";
  description =
    "Load full instructions for a configured skill from ~/.vellum/workspace/skills.";
  category = "skills";
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description: "The skill id or skill name to load.",
          },
          reason: {
            type: "string",
            description:
              "Brief non-technical explanation of what you are loading and why, shown to the user as a status update. Use simple language a non-technical person would understand.",
          },
        },
        required: ["skill"],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const selector = input.skill;
    if (typeof selector !== "string" || selector.trim().length === 0) {
      return {
        content: "Error: skill is required and must be a non-empty string",
        isError: true,
      };
    }

    const loaded = loadSkillBySelector(selector);
    if (!loaded.skill) {
      return {
        content: `Error: ${loaded.error ?? "Failed to load skill"}`,
        isError: true,
      };
    }

    const skill = loaded.skill;

    // Assistant feature flag gate: reject loading if the skill's flag is OFF
    const config = getConfig();
    const flagKey = skillFlagKey(skill);
    if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) {
      return {
        content: `Error: skill "${skill.id}" is currently unavailable (disabled by feature flag)`,
        isError: true,
      };
    }

    // Load catalog for include validation and child metadata output
    let catalogIndex: Map<string, SkillSummary> | undefined;
    if (skill.includes && skill.includes.length > 0) {
      const catalog = loadSkillCatalog();
      catalogIndex = indexCatalogById(catalog);

      // Validate recursive includes (fail-closed)
      const validation = validateIncludes(skill.id, catalogIndex);
      if (!validation.ok) {
        if (validation.error === "missing") {
          return {
            content: `Error: skill "${skill.id}" includes "${
              validation.missingChildId
            }" which was not found (referenced by "${
              validation.parentId
            }" via path: ${validation.path.join(" → ")})`,
            isError: true,
          };
        }
        if (validation.error === "cycle") {
          return {
            content: `Error: skill "${
              skill.id
            }" has a circular include chain: ${validation.cyclePath.join(
              " → ",
            )}`,
            isError: true,
          };
        }
        return {
          content: `Error: skill "${skill.id}" has an invalid include graph`,
          isError: true,
        };
      }
    }

    const body = skill.body.length > 0 ? skill.body : "(No body content)";

    // Build immediate children metadata section and load included skill bodies
    let immediateChildrenSection: string;
    const includedBodies: string[] = [];
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      const childLines: string[] = [];
      for (const childId of skill.includes) {
        const child = catalogIndex.get(childId);
        if (!child) continue;
        const childFlagKey = skillFlagKey(child);
        if (
          childFlagKey &&
          !isAssistantFeatureFlagEnabled(childFlagKey, config)
        )
          continue;

        childLines.push(
          `  - ${child.id}: ${child.displayName} — ${child.description} (${child.skillFilePath})`,
        );

        // Load the included skill's body content
        const childLoaded = loadSkillBySelector(childId);
        if (childLoaded.skill && childLoaded.skill.body.length > 0) {
          includedBodies.push(
            `--- Included Skill: ${childLoaded.skill.displayName} (${childId}) ---\n${childLoaded.skill.body}`,
          );
        }
      }
      immediateChildrenSection = `Included Skills (immediate):\n${childLines.join(
        "\n",
      )}`;
    } else {
      immediateChildrenSection = "Included Skills (immediate): none";
    }

    let versionHash: string | undefined;
    try {
      versionHash = computeSkillVersionHash(skill.directoryPath);
    } catch (err) {
      log.warn(
        { err, skillId: skill.id },
        "Failed to compute skill version hash for marker",
      );
    }

    const versionAttr = versionHash ? ` version="${versionHash}"` : "";

    // Emit markers for included skills so their tools get projected
    const includeMarkers: string[] = [];
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      for (const childId of skill.includes) {
        const child = catalogIndex.get(childId);
        if (!child) continue;
        const childFlagKey2 = skillFlagKey(child);
        if (
          childFlagKey2 &&
          !isAssistantFeatureFlagEnabled(childFlagKey2, config)
        )
          continue;
        let childHash: string | undefined;
        try {
          childHash = computeSkillVersionHash(child.directoryPath);
        } catch (err) {
          log.warn(
            { err, skillId: childId },
            "Failed to compute included skill version hash",
          );
        }
        const childVersionAttr = childHash ? ` version="${childHash}"` : "";
        includeMarkers.push(
          `<loaded_skill id="${childId}"${childVersionAttr} />`,
        );
      }
    }

    return {
      content: [
        `Skill: ${skill.displayName}`,
        `ID: ${skill.id}`,
        `Description: ${skill.description}`,
        `Path: ${skill.skillFilePath}`,
        "",
        body,
        "",
        ...includedBodies.flatMap((b) => [b, ""]),
        immediateChildrenSection,
        "",
        `<loaded_skill id="${skill.id}"${versionAttr} />`,
        ...includeMarkers,
      ].join("\n"),
      isError: false,
    };
  }
}

registerTool(new SkillLoadTool());
