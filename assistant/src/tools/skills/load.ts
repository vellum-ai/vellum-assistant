import { existsSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { skillFlagKey } from "../../config/skill-state.js";
import type { SkillSummary, SkillToolManifest } from "../../config/skills.js";
import {
  listReferenceFiles,
  loadSkillBySelector,
  loadSkillCatalog,
} from "../../config/skills.js";
import { RiskLevel } from "../../permissions/types.js";
import type { ToolDefinition } from "../../providers/types.js";
import {
  autoInstallFromCatalog,
  resolveCatalog,
} from "../../skills/catalog-install.js";
import {
  collectAllMissing,
  indexCatalogById,
  validateIncludes,
} from "../../skills/include-graph.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { getLogger } from "../../util/logger.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

const log = getLogger("skill-load");

/**
 * Attempt to load and parse TOOLS.json from a skill directory.
 * Returns undefined if the file doesn't exist or fails to parse.
 */
function loadToolManifest(
  directoryPath: string,
): SkillToolManifest | undefined {
  const manifestPath = join(directoryPath, "TOOLS.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    return parseToolManifestFile(manifestPath);
  } catch (err) {
    log.warn(
      { err, manifestPath },
      "Failed to parse TOOLS.json for tool schema output",
    );
    return undefined;
  }
}

/**
 * Format a skill tool manifest into a human-readable "Available Tools" section
 * that instructs the LLM to use `skill_execute` to invoke the tools.
 *
 * When `childSkillName` is provided, a lighter sub-heading is used instead of
 * the full `## Available Tools` header + preamble, avoiding duplicate headers
 * when parent and child skills both have TOOLS.json.
 */
function formatToolSchemas(
  manifest: SkillToolManifest,
  childSkillName?: string,
): string {
  const lines: string[] = childSkillName
    ? [`### Tools from ${childSkillName}`, ""]
    : [
        "## Available Tools",
        "",
        "Use `skill_execute` to call these tools.",
        "",
      ];

  const toolHeadingLevel = childSkillName ? "####" : "###";

  for (const tool of manifest.tools) {
    lines.push(`${toolHeadingLevel} ${tool.name}`);
    lines.push(tool.description);

    const schema = tool.input_schema;
    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (properties && Object.keys(properties).length > 0) {
      const requiredSet = new Set<string>(
        Array.isArray(schema.required) ? (schema.required as string[]) : [],
      );

      lines.push("Parameters:");
      for (const [paramName, paramDef] of Object.entries(properties)) {
        const paramType =
          typeof paramDef.type === "string" ? paramDef.type : "any";
        const requiredLabel = requiredSet.has(paramName)
          ? "required"
          : "optional";
        const descPart =
          typeof paramDef.description === "string"
            ? `: ${paramDef.description}`
            : "";
        lines.push(
          `- ${paramName} (${paramType}, ${requiredLabel})${descPart}`,
        );
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

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

    let loaded = loadSkillBySelector(selector);

    // Auto-install from catalog if the skill isn't found locally
    if (
      !loaded.skill &&
      (loaded.errorCode === "not_found" || loaded.errorCode === "empty_catalog")
    ) {
      try {
        const installed = await autoInstallFromCatalog(selector);
        if (installed) {
          log.info({ skillId: selector }, "Auto-installed skill from catalog");
          loaded = loadSkillBySelector(selector);
        }
      } catch (err) {
        const installError = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, skillId: selector },
          "Auto-install from catalog failed",
        );
        return {
          content: `Error: skill "${selector}" was found in the catalog but installation failed: ${installError}`,
          isError: true,
        };
      }
    }

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
      let catalog = loadSkillCatalog();
      catalogIndex = indexCatalogById(catalog);

      // Auto-install missing includes before validation (max 5 rounds for transitive deps)
      // Defer catalog resolution until we confirm there are missing includes,
      // then cache the result to avoid redundant network requests per dependency.
      let remoteCatalog: Awaited<ReturnType<typeof resolveCatalog>> | undefined;

      const MAX_INSTALL_ROUNDS = 5;
      for (let round = 0; round < MAX_INSTALL_ROUNDS; round++) {
        const missing = collectAllMissing(skill.id, catalogIndex);
        if (missing.size === 0) break;

        // Lazily resolve catalog on first round with missing includes
        if (!remoteCatalog) {
          try {
            remoteCatalog = await resolveCatalog([...missing][0]);
          } catch (err) {
            log.warn(
              { err, skillId: skill.id },
              "Failed to resolve catalog for include auto-install",
            );
            break;
          }
        }

        let installedAny = false;
        for (const missingId of missing) {
          try {
            const installed = await autoInstallFromCatalog(
              missingId,
              remoteCatalog,
            );
            if (installed) {
              log.info(
                { skillId: missingId, parentSkillId: skill.id },
                "Auto-installed missing include",
              );
              installedAny = true;
            }
          } catch (err) {
            log.warn(
              { err, skillId: missingId },
              "Failed to auto-install missing include",
            );
          }
        }

        if (!installedAny) break; // Nothing could be installed, stop trying

        // Reload catalog to pick up newly installed skills
        catalog = loadSkillCatalog();
        catalogIndex = indexCatalogById(catalog);
      }

      // Validate (fail-closed — catches genuinely missing deps + cycles)
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

    // Build reference file listing (if any)
    const referenceListing = listReferenceFiles(skill.directoryPath);

    // Load tool schemas for the main skill
    const mainManifest = loadToolManifest(skill.directoryPath);
    const toolSchemasSection = mainManifest
      ? formatToolSchemas(mainManifest)
      : undefined;

    // Build immediate children metadata section and load included skill bodies
    let immediateChildrenSection: string;
    const includedBodies: string[] = [];
    let anyChildHasTools = false;
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

          // Load tool schemas for the included skill (lighter sub-heading)
          const childManifest = loadToolManifest(
            childLoaded.skill.directoryPath,
          );
          if (childManifest) {
            anyChildHasTools = true;
            includedBodies.push(
              formatToolSchemas(childManifest, childLoaded.skill.displayName),
            );
          }
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
        ...(referenceListing ? [referenceListing, ""] : []),
        ...(toolSchemasSection ? [toolSchemasSection, ""] : []),
        ...(!toolSchemasSection && anyChildHasTools
          ? [
              "## Available Tools",
              "",
              "Use `skill_execute` to call these tools.",
              "",
            ]
          : []),
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

export const skillLoadTool = new SkillLoadTool();
registerTool(skillLoadTool);
