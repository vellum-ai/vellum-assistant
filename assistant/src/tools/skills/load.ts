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
import { renderInlineCommands } from "../../skills/inline-command-render.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDirDisplay } from "../../util/platform.js";
import { registerTool } from "../registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../types.js";

/** Canonical feature flag key for inline skill command expansion. */
const INLINE_COMMANDS_FLAG_KEY = "feature_flags.inline-skill-commands.enabled";

/** Skill sources eligible for inline command expansion in v1. */
const INLINE_COMMAND_ELIGIBLE_SOURCES = new Set([
  "bundled",
  "managed",
  "workspace",
]);

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
    lines.push(
      tool.description.replaceAll("{workspaceDir}", getWorkspaceDirDisplay()),
    );

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
            ? `: ${paramDef.description.replaceAll("{workspaceDir}", getWorkspaceDirDisplay())}`
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
    "Load full instructions for a skill. Works for both bundled skills (listed in the catalog) and custom workspace skills.";
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
    context: ToolContext,
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

      // Validate (fail-closed - catches genuinely missing deps + cycles)
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

    let body = skill.body.length > 0 ? skill.body : "(No body content)";

    // ── Inline command expansion ──────────────────────────────────────────
    const hasInlineCommands =
      skill.inlineCommandExpansions && skill.inlineCommandExpansions.length > 0;

    if (hasInlineCommands) {
      const inlineFlagEnabled = isAssistantFeatureFlagEnabled(
        INLINE_COMMANDS_FLAG_KEY,
        config,
      );

      if (!inlineFlagEnabled) {
        // Feature flag is off: fail closed instead of leaving live tokens in
        // the prompt that the LLM might try to interpret.
        return {
          content: `Error: skill "${skill.id}" contains inline command expansions but the inline-skill-commands feature flag is disabled. Enable the flag to use this skill.`,
          isError: true,
        };
      }

      if (skill.source === "extra") {
        // Third-party extra roots are out of scope for inline command
        // expansion in v1. Reject explicitly so the failure is clear.
        return {
          content: `Error: skill "${skill.id}" contains inline command expansions but inline commands are not supported for third-party (extra) skill sources.`,
          isError: true,
        };
      }

      if (!INLINE_COMMAND_ELIGIBLE_SOURCES.has(skill.source)) {
        // Defensive: reject any other unknown sources that somehow have
        // inline commands. Should not happen with current SkillSource values,
        // but fail closed if a new source type is added without updating this.
        return {
          content: `Error: skill "${skill.id}" contains inline command expansions but source "${skill.source}" is not eligible for inline command expansion.`,
          isError: true,
        };
      }

      // Render inline commands by executing each through the sandbox runner
      const renderResult = await renderInlineCommands(
        body,
        skill.inlineCommandExpansions!,
        context.workingDir,
      );
      body = renderResult.renderedBody;

      log.info(
        {
          skillId: skill.id,
          expandedCount: renderResult.expandedCount,
          failedCount: renderResult.failedCount,
        },
        "Rendered inline command expansions",
      );
    }

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
          `  - ${child.id}: ${child.displayName} - ${child.description} (${child.skillFilePath})`,
        );

        // Load the included skill's body content
        const childLoaded = loadSkillBySelector(childId);
        if (childLoaded.skill && childLoaded.skill.body.length > 0) {
          let childBody = childLoaded.skill.body;

          // ── Inline command expansion for included child skill ─────────
          const childHasInlineCommands =
            childLoaded.skill.inlineCommandExpansions &&
            childLoaded.skill.inlineCommandExpansions.length > 0;

          if (childHasInlineCommands) {
            const childInlineFlagEnabled = isAssistantFeatureFlagEnabled(
              INLINE_COMMANDS_FLAG_KEY,
              config,
            );

            // Fail closed: if the flag is off, reject the entire skill_load
            // just like we do for root skills. Leaving raw !`...` tokens in
            // the prompt would violate the documented fail-closed contract.
            if (!childInlineFlagEnabled) {
              return {
                content: `Error: included skill "${childId}" contains inline command expansions but the inline-skill-commands feature flag is disabled. Enable the flag to use skill "${skill.id}".`,
                isError: true,
              };
            }

            if (childLoaded.skill.source === "extra") {
              return {
                content: `Error: included skill "${childId}" contains inline command expansions but inline commands are not supported for third-party (extra) skill sources.`,
                isError: true,
              };
            }

            if (
              !INLINE_COMMAND_ELIGIBLE_SOURCES.has(childLoaded.skill.source)
            ) {
              return {
                content: `Error: included skill "${childId}" contains inline command expansions but source "${childLoaded.skill.source}" is not eligible for inline command expansion.`,
                isError: true,
              };
            }

            try {
              const childRenderResult = await renderInlineCommands(
                childBody,
                childLoaded.skill.inlineCommandExpansions!,
                context.workingDir,
              );
              childBody = childRenderResult.renderedBody;

              log.info(
                {
                  skillId: childId,
                  parentSkillId: skill.id,
                  expandedCount: childRenderResult.expandedCount,
                  failedCount: childRenderResult.failedCount,
                },
                "Rendered inline command expansions for included skill",
              );
            } catch (err) {
              log.warn(
                { err, skillId: childId, parentSkillId: skill.id },
                "Failed to render inline commands for included skill, using raw body",
              );
            }
          }

          includedBodies.push(
            `--- Included Skill: ${childLoaded.skill.displayName} (${childId}) ---\n${childBody}`,
          );

          // List reference files for the included skill
          const childRefs = listReferenceFiles(childLoaded.skill.directoryPath);
          if (childRefs) {
            includedBodies.push(childRefs);
          }

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
