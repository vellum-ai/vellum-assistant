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
import {
  autoInstallFromCatalog,
  resolveCatalog,
} from "../../skills/catalog-install.js";
import {
  refreshInstalledSkillIfStale,
  type SkillRefreshOutcome,
} from "../../skills/catalog-refresh.js";
import {
  collectAllMissing,
  indexCatalogById,
  validateIncludeCycles,
} from "../../skills/include-graph.js";
import { renderInlineCommands } from "../../skills/inline-command-render.js";
import { parseToolManifestFile } from "../../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../../skills/version-hash.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDirDisplay } from "../../util/platform.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

/** Skill sources eligible for inline command expansion in v1. */
const INLINE_COMMAND_ELIGIBLE_SOURCES = new Set([
  "bundled",
  "managed",
  "workspace",
]);

/** Matches raw `` !`...` `` inline command tokens in a skill body. */
const INLINE_COMMAND_TOKEN_PATTERN = /!`[^`]*`/g;

/**
 * Replacement for inline command tokens when they are not rendered during
 * disk-pressure cleanup mode — keeps the raw tokens out of the prompt without
 * executing any shell.
 */
const INLINE_COMMAND_CLEANUP_STUB =
  "[inline command skipped: storage cleanup mode]";

/**
 * Upper bound on how long a load waits for the staleness refresh. With a
 * warm catalog cache the refresh check is local file IO and finishes well
 * inside this; a cold cache pays one platform fetch, and if that runs long
 * the load proceeds with the current copy while the refresh completes in
 * the background for the next load.
 */
const SKILL_REFRESH_WAIT_MS = 2_000;

const log = getLogger("skill-load");

/**
 * Trigger a staleness refresh for a catalog-installed skill, waiting at most
 * `SKILL_REFRESH_WAIT_MS`. Returns `"refreshed"` when the on-disk copy was
 * replaced within the window (caller should re-read it), or `"pending"`/any
 * skip outcome otherwise. Best-effort — `refreshInstalledSkillIfStale` never
 * throws and no-ops for non-catalog-managed skills.
 */
async function refreshCatalogSkillBounded(
  skillId: string,
): Promise<SkillRefreshOutcome | "pending"> {
  return Promise.race([
    refreshInstalledSkillIfStale(skillId),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), SKILL_REFRESH_WAIT_MS);
    }),
  ]);
}

/** Compute a skill directory's version hash, returning undefined on error. */
function safeComputeVersionHash(
  directoryPath: string,
  logCtx: { skillId: string },
): string | undefined {
  try {
    return computeSkillVersionHash(directoryPath);
  } catch (err) {
    log.warn(
      { err, skillId: logCtx.skillId },
      "Failed to compute skill version hash for marker",
    );
    return undefined;
  }
}

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

export const skillLoadTool = {
  name: "skill_load",

  description:
    'Load full instructions for a skill. Works for both bundled skills (listed in the catalog) and custom workspace skills. Bundled/first-party skills (like `app-builder`) are already installed — loading only activates their instructions for the current conversation, since skills unload between turns; treat "load" as activation, not installation, and don\'t tell users a bundled skill needs installing. Loading can still fail (e.g. a feature-gated skill returns "currently unavailable", or the load errors) — if it does, relay that specific error rather than claiming the skill is not installed or offering to install it. For app, website, dashboard, game, calculator, tracker, visualization, or interactive tool requests, load `app-builder` with `skill: "app-builder"`.',

  category: "skills",

  executionTarget: "sandbox",

  defaultRiskLevel: RiskLevel.Low,

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

    // During disk-pressure cleanup mode, skill_load must not produce side
    // effects: no auto-install (workspace writes / `bun install`) and no inline
    // command execution. Instructions are still returned so the assistant can
    // load the system-storage-cleanup skill (and any already-installed skill).
    const cleanupMode = context.diskPressureCleanupModeActive === true;

    let loaded = loadSkillBySelector(selector);

    // Auto-install from catalog if the skill isn't found locally
    if (
      !loaded.skill &&
      !cleanupMode &&
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

    let skill = loaded.skill;

    // Catalog-installed copies load with user-skill precedence and would
    // otherwise stay frozen at install time. Refresh a pristine, stale
    // vellum-origin install before serving its instructions, bounded so a
    // slow catalog fetch cannot stall the load — a refresh that misses the
    // window still lands for the next load. `managed` is the source catalog
    // installs resolve as; other sources are never catalog-managed.
    if (!cleanupMode && skill.source === "managed") {
      const outcome = await refreshCatalogSkillBounded(skill.id);
      if (outcome === "refreshed") {
        // Re-resolve by the stable id, not the original selector: a
        // display-name or id-prefix selector can fail or match a different
        // skill if the refreshed SKILL.md changed the name. The directory id
        // is invariant across an in-place refresh, so it always re-reads the
        // freshly-installed copy. If the reload somehow fails, keep serving
        // the pre-refresh object so body and marker stay mutually consistent.
        const reloaded = loadSkillBySelector(skill.id);
        if (reloaded.skill) {
          skill = reloaded.skill;
        }
      }
    }

    // Capture the version hash of the content being served NOW, before the
    // inline-command / include awaits below. If a refresh that missed the
    // bounded window commits in the background during those awaits, the
    // atomic swap changes the on-disk hash — recomputing the activation
    // marker from disk at the end would then advertise a version whose body
    // was never injected this turn. Pinning the hash here keeps the emitted
    // `<loaded_skill version>` marker consistent with the body served, and the
    // background refresh is picked up on the next load.
    const servedVersionHash = safeComputeVersionHash(skill.directoryPath, {
      skillId: skill.id,
    });

    // Per-chat plugin scope gate: a plugin-owned skill whose owning plugin is
    // outside the conversation's effective set must not have its instructions
    // loaded. Mirrors the projection/tools filter's owner-id lookup
    // (`filterSkillsByEnabledPlugins`). `null` = no restriction; first-party
    // defaults are always in the set, so bundled/workspace skills pass.
    const enabledPluginSet = context.enabledPluginSet ?? null;
    if (
      enabledPluginSet !== null &&
      skill.owner?.kind === "plugin" &&
      !enabledPluginSet.has(skill.owner.id)
    ) {
      return {
        content: `Error: skill "${skill.id}" is not available in this conversation — its plugin is not enabled here.`,
        isError: true,
      };
    }

    // Per-chat plugin scope gate for INCLUDED child skills. Mirrors the
    // top-level owner-id check above: a child owned by a plugin outside the
    // effective set (and not a first-party default — those ids are unioned into
    // the set) must be omitted from include resolution entirely, so an in-scope
    // parent cannot inject an out-of-scope plugin child's body or loaded-skill
    // marker. `null` set = no restriction; bundled/core children (no plugin
    // owner) always pass.
    const childOutOfPluginScope = (child: SkillSummary): boolean =>
      enabledPluginSet !== null &&
      child.owner?.kind === "plugin" &&
      !enabledPluginSet.has(child.owner.id);

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
    let missingIncludedSkillIds: string[] = [];
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

        // Under the disk-pressure lock, never auto-install missing includes
        // (that writes to the workspace). Leave them advisory ("not loaded").
        if (cleanupMode) break;

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

      missingIncludedSkillIds = [...collectAllMissing(skill.id, catalogIndex)];

      // Validate cycles fail closed. Missing includes are advisory: the parent
      // skill should still load so the assistant can decide whether to search
      // for and install the suggested dependency.
      const validation = validateIncludeCycles(skill.id, catalogIndex);
      if (!validation.ok) {
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
      }
    }

    let body = skill.body.length > 0 ? skill.body : "(No body content)";

    // ── Inline command expansion ──────────────────────────────────────────
    const hasInlineCommands =
      skill.inlineCommandExpansions && skill.inlineCommandExpansions.length > 0;

    if (hasInlineCommands && cleanupMode) {
      // Under the disk-pressure lock, loading a skill must not execute shell.
      // Strip inline command tokens instead of rendering them; the rest of the
      // instructions are still returned.
      body = body.replace(
        INLINE_COMMAND_TOKEN_PATTERN,
        INLINE_COMMAND_CLEANUP_STUB,
      );
      log.info(
        { skillId: skill.id },
        "Skipped inline command expansion during disk pressure cleanup mode",
      );
    } else if (hasInlineCommands) {
      if (skill.source === "extra" || skill.source === "plugin") {
        // Third-party skill roots — `extra` dirs and skills shipped inside
        // installed plugins — are out of scope for inline command expansion.
        // Their bodies are untrusted, so reject explicitly rather than
        // executing shell from them.
        return {
          content: `Error: skill "${skill.id}" contains inline command expansions but inline commands are not supported for third-party (${skill.source}) skill sources.`,
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
    // Version hash of each included child's served body, pinned at read-time so
    // its activation marker stays consistent with the body injected here even
    // if a background refresh swaps the child's on-disk copy mid-load.
    const childServedVersionHashes = new Map<string, string | undefined>();
    // Children that cleared every gate against their post-refresh metadata and
    // were therefore listed/loaded. The marker loop below emits `<loaded_skill>`
    // markers only for these, so a child gated out after its refresh gets
    // neither body nor marker.
    const activatedChildIds = new Set<string>();
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      const childLines: string[] = [];
      for (const childId of skill.includes) {
        const child = catalogIndex.get(childId);
        if (!child) continue;
        // Skip a child whose owning plugin is outside this conversation's
        // effective set — do not list it, load its body, or surface its tools.
        // Plugin ownership is a function of where the skill lives, so it is
        // stable across an in-place refresh; the feature-flag gate below is
        // re-evaluated post-refresh because the flag comes from frontmatter.
        if (childOutOfPluginScope(child)) continue;
        const childFlagKey = skillFlagKey(child);
        if (
          childFlagKey &&
          !isAssistantFeatureFlagEnabled(childFlagKey, config)
        )
          continue;

        // Included children are read directly here rather than through
        // skill_load, so refresh a stale managed include before reading its
        // body — otherwise a parent load would inject the child's old
        // instructions even after a fix was published for the child.
        if (!cleanupMode && child.source === "managed") {
          await refreshCatalogSkillBounded(childId);
        }

        // Load the included skill's body content
        const childLoaded = loadSkillBySelector(childId);
        if (!childLoaded.skill) continue;

        // Re-run the feature-flag gate against the (possibly refreshed)
        // frontmatter: a catalog update may have moved the child behind a
        // now-disabled flag, and the pre-refresh gate above evaluated the
        // stale summary. Gate the refreshed body + marker out if so.
        const freshChildFlagKey = skillFlagKey(childLoaded.skill);
        if (
          freshChildFlagKey &&
          !isAssistantFeatureFlagEnabled(freshChildFlagKey, config)
        ) {
          continue;
        }

        activatedChildIds.add(childId);
        // List from the refreshed metadata so the summary line matches the
        // body actually injected.
        childLines.push(
          `  - ${childLoaded.skill.id}: ${childLoaded.skill.displayName} - ${childLoaded.skill.description} (${childLoaded.skill.skillFilePath})`,
        );

        if (childLoaded.skill.body.length > 0) {
          // Pin the hash of the child content read here (no await between the
          // refresh above and this read), so its marker below matches the
          // injected body rather than a later background-refreshed copy.
          childServedVersionHashes.set(
            childId,
            safeComputeVersionHash(childLoaded.skill.directoryPath, {
              skillId: childId,
            }),
          );
          let childBody = childLoaded.skill.body;

          // ── Inline command expansion for included child skill ─────────
          const childHasInlineCommands =
            childLoaded.skill.inlineCommandExpansions &&
            childLoaded.skill.inlineCommandExpansions.length > 0;

          if (childHasInlineCommands && cleanupMode) {
            // No shell execution under the disk-pressure lock — strip the
            // child's inline command tokens rather than rendering them.
            childBody = childBody.replace(
              INLINE_COMMAND_TOKEN_PATTERN,
              INLINE_COMMAND_CLEANUP_STUB,
            );
          } else if (childHasInlineCommands) {
            if (
              childLoaded.skill.source === "extra" ||
              childLoaded.skill.source === "plugin"
            ) {
              return {
                content: `Error: included skill "${childId}" contains inline command expansions but inline commands are not supported for third-party (${childLoaded.skill.source}) skill sources.`,
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
              log.error(
                { err, skillId: childId, parentSkillId: skill.id },
                "Failed to render inline commands for included skill; falling back to sanitized body",
              );
              // Strip raw !`...` inline command tokens so they don't leak into
              // the prompt. Replace with a safe stub to maintain fail-closed
              // contract for raw tokens while still isolating child failures.
              childBody = childBody.replace(
                /!`[^`]*`/g,
                "[inline command unavailable]",
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
      immediateChildrenSection =
        childLines.length > 0
          ? `Included Skills (immediate):\n${childLines.join("\n")}`
          : "Included Skills (immediate): none";
    } else {
      immediateChildrenSection = "Included Skills (immediate): none";
    }

    const missingIncludesSection =
      missingIncludedSkillIds.length > 0
        ? [
            "Suggested Included Skills (not loaded):",
            ...missingIncludedSkillIds.map(
              (id) =>
                `  - ${id}: not installed or unavailable. If this task needs it, search for and install this skill, then load it.`,
            ),
          ].join("\n")
        : undefined;

    const versionAttr = servedVersionHash
      ? ` version="${servedVersionHash}"`
      : "";

    // Emit markers for included skills so their tools get projected. Gate on
    // the body loop's post-refresh activation decision (which already applied
    // plugin scope + the refreshed feature flag), so a child's marker is
    // emitted iff its body was, keeping activation consistent with what was
    // injected.
    const includeMarkers: string[] = [];
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      for (const childId of skill.includes) {
        if (!activatedChildIds.has(childId)) continue;
        const child = catalogIndex.get(childId);
        if (!child) continue;
        // Prefer the hash pinned when the child body was read (kept
        // consistent with the injected body); fall back to a fresh read for a
        // child that was activated but whose body was empty/unread above. The
        // directory id is stable across refresh, so this reads the same
        // (refreshed) copy.
        const childHash = childServedVersionHashes.has(childId)
          ? childServedVersionHashes.get(childId)
          : safeComputeVersionHash(child.directoryPath, { skillId: childId });
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
        ...(missingIncludesSection ? [missingIncludesSection] : []),
        "",
        `<loaded_skill id="${skill.id}"${versionAttr} />`,
        ...includeMarkers,
      ].join("\n"),
      isError: false,
    };
  },
} satisfies ToolDefinition;
