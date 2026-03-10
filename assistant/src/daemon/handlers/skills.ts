import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { resolveSkillStates, skillFlagKey } from "../../config/skill-state.js";
import {
  ensureSkillIcon,
  loadSkillBySelector,
  loadSkillCatalog,
  type SkillSummary,
} from "../../config/skills.js";
import {
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import {
  clawhubCheckUpdates,
  clawhubInspect,
  type ClawhubInspectResult,
  clawhubInstall,
  clawhubSearch,
  clawhubUpdate,
} from "../../skills/clawhub.js";
import {
  createManagedSkill,
  deleteManagedSkill,
  removeSkillsIndexEntry,
  validateManagedSkillId,
} from "../../skills/managed-store.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
import type {
  SkillDetailRequest,
  SkillsCheckUpdatesRequest,
  SkillsConfigureRequest,
  SkillsCreateRequest,
  SkillsDisableRequest,
  SkillsDraftRequest,
  SkillsEnableRequest,
  SkillsInspectRequest,
  SkillsInstallRequest,
  SkillsSearchRequest,
  SkillsUninstallRequest,
  SkillsUpdateRequest,
} from "../message-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  ensureSkillEntry,
  type HandlerContext,
  log,
} from "./shared.js";

// ─── Shared context for standalone functions ─────────────────────────────────

/**
 * Minimal context needed by the standalone skill business-logic functions.
 * HandlerContext satisfies this interface, but HTTP routes can also provide
 * a compatible object without coupling to IPC internals.
 */
export interface SkillOperationContext {
  debounceTimers: HandlerContext["debounceTimers"];
  setSuppressConfigReload(value: boolean): void;
  updateConfigFingerprint(): void;
  broadcast: HandlerContext["broadcast"];
}

// ─── Provenance resolution ──────────────────────────────────────────────────

interface SkillProvenance {
  kind: "first-party" | "third-party" | "local";
  provider?: string;
  originId?: string;
  sourceUrl?: string;
}

const CLAWHUB_BASE_URL = "https://skills.sh";

function resolveProvenance(summary: SkillSummary): SkillProvenance {
  // Bundled skills are always first-party (shipped with Vellum)
  if (summary.source === "bundled") {
    return { kind: "first-party", provider: "Vellum" };
  }

  // Managed skills are third-party (installed from clawhub). The homepage field
  // confirms provenance.
  if (summary.source === "managed") {
    if (
      summary.homepage?.includes("skills.sh") ||
      summary.homepage?.includes("clawhub")
    ) {
      return {
        kind: "third-party",
        provider: "skills.sh",
        originId: summary.id,
        sourceUrl:
          summary.homepage ??
          `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(summary.id)}`,
      };
    }
    // No positive evidence of clawhub origin -- likely user-authored.
    // Default to "local" to avoid mislabeling.
    return { kind: "local" };
  }

  // Workspace and extra skills are user-provided
  if (summary.source === "workspace" || summary.source === "extra") {
    return { kind: "local" };
  }

  return { kind: "local" };
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedFrontmatter {
  skillId?: string;
  name?: string;
  description?: string;
  emoji?: string;
  body: string;
}

function parseFrontmatter(sourceText: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(sourceText);
  if (!match) return { body: sourceText };

  const yamlBlock = match[1];
  const body = match[2].replace(/\r\n/g, "\n");

  const result: ParsedFrontmatter = { body };

  // Simple YAML key-value extraction (handles quoted and unquoted values)
  for (const line of yamlBlock.split(/\r?\n/)) {
    const kvMatch = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim());
    if (!kvMatch) continue;
    const key = kvMatch[1];
    // Strip surrounding quotes
    let value = kvMatch[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "skill-id":
      case "skillId":
      case "id":
        result.skillId = value;
        break;
      case "name":
        result.name = value;
        break;
      case "description":
        result.description = value;
        break;
      case "emoji":
        result.emoji = value;
        break;
    }
  }

  return result;
}

// ─── Slug normalization ──────────────────────────────────────────────────────

function toSkillSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // replace non-valid chars with hyphens
    .replace(/^[^a-z0-9]+/, "") // must start with alphanumeric
    .replace(/-+/g, "-") // collapse multiple hyphens
    .slice(0, 50)
    .replace(/-$/, ""); // no trailing hyphen (after truncation)
}

// ─── Deterministic heuristic draft ───────────────────────────────────────────

function heuristicDraft(body: string): {
  skillId: string;
  name: string;
  description: string;
  emoji: string;
} {
  const lines = body.split("\n").filter((l) => l.trim());
  const firstLine = lines[0]?.trim() ?? "";
  const name =
    firstLine.replace(/^#+\s*/, "").slice(0, 100) || "Untitled Skill";
  const skillId = toSkillSlug(name) || "untitled-skill";
  const description = body.trim().slice(0, 200) || "No description provided";
  return { skillId, name, description, emoji: "\u{1F4DD}" };
}

const LLM_DRAFT_TIMEOUT_MS = 15_000;

// ─── Standalone business-logic functions ─────────────────────────────────────
// These are consumed by both the IPC handlers below and the HTTP route layer.

/** Helper: suppress config reload, save, debounce, and update fingerprint. */
function saveConfigWithSuppression(
  raw: Record<string, unknown>,
  ctx: SkillOperationContext,
): void {
  ctx.setSuppressConfigReload(true);
  try {
    saveRawConfig(raw);
  } catch (err) {
    ctx.setSuppressConfigReload(false);
    throw err;
  }
  invalidateConfigCache();

  ctx.debounceTimers.schedule(
    "__suppress_reset__",
    () => {
      ctx.setSuppressConfigReload(false);
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  ctx.updateConfigFingerprint();
}

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  homepage?: string;
  source: "bundled" | "managed" | "workspace" | "clawhub" | "extra";
  state: "enabled" | "disabled" | "available";
  degraded: boolean;
  missingRequirements?: {
    bins?: string[];
    env?: string[];
    permissions?: string[];
  };
  updateAvailable: boolean;
  userInvocable: boolean;
  provenance: SkillProvenance;
}

export function listSkills(_ctx: SkillOperationContext): SkillListItem[] {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  return resolved.map((r) => ({
    id: r.summary.id,
    name: r.summary.displayName,
    description: r.summary.description,
    emoji: r.summary.emoji,
    homepage: r.summary.homepage,
    source: r.summary.source,
    state: (r.state === "degraded" ? "enabled" : r.state) as
      | "enabled"
      | "disabled"
      | "available",
    degraded: r.degraded,
    missingRequirements: r.missingRequirements,
    updateAvailable: false,
    userInvocable: r.summary.userInvocable,
    provenance: resolveProvenance(r.summary),
  }));
}

export function enableSkill(
  skillId: string,
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, skillId).enabled = true;
    saveConfigWithSuppression(raw, ctx);
    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "enabled",
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to enable skill");
    return { success: false, error: message };
  }
}

export function disableSkill(
  skillId: string,
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, skillId).enabled = false;
    saveConfigWithSuppression(raw, ctx);
    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "disabled",
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to disable skill");
    return { success: false, error: message };
  }
}

export function configureSkill(
  skillId: string,
  config: {
    env?: Record<string, string>;
    apiKey?: string;
    config?: Record<string, unknown>;
  },
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    const entry = ensureSkillEntry(raw, skillId);
    if (config.env) entry.env = config.env;
    if (config.apiKey !== undefined) entry.apiKey = config.apiKey;
    if (config.config) entry.config = config.config;
    saveConfigWithSuppression(raw, ctx);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to configure skill");
    return { success: false, error: message };
  }
}

export async function installSkill(
  spec: { slug: string; version?: string },
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    // Bundled skills are already available — no install needed
    const catalog = loadSkillCatalog();

    // Feature flag gate: reject install if the skill's flag is disabled
    const config = getConfig();
    const flaggedSkill = catalog.find((s) => s.id === spec.slug);
    if (flaggedSkill) {
      const flagKey = skillFlagKey(flaggedSkill);
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) {
        return {
          success: false,
          error: `Skill "${spec.slug}" is currently unavailable (disabled by feature flag)`,
        };
      }
    }

    const bundled = catalog.find(
      (s) => s.id === spec.slug && s.source === "bundled",
    );
    if (bundled) {
      // Auto-enable the bundled skill so it's immediately usable
      try {
        const raw = loadRawConfig();
        ensureSkillEntry(raw, spec.slug).enabled = true;
        saveConfigWithSuppression(raw, ctx);
        ctx.broadcast({
          type: "skills_state_changed",
          name: spec.slug,
          state: "enabled",
        });
      } catch (err) {
        log.warn(
          { err, skillId: spec.slug },
          "Failed to auto-enable bundled skill",
        );
      }
      return { success: true };
    }

    // Install from clawhub (community)
    const result = await clawhubInstall(spec.slug, { version: spec.version });
    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }
    const rawId = result.skillName ?? spec.slug;
    const skillId = rawId.includes("/") ? rawId.split("/").pop()! : rawId;

    // Reload skill catalog so the newly installed skill is picked up
    loadSkillCatalog();

    // Auto-enable the newly installed skill
    try {
      const raw = loadRawConfig();
      ensureSkillEntry(raw, skillId).enabled = true;
      saveConfigWithSuppression(raw, ctx);
      ctx.broadcast({
        type: "skills_state_changed",
        name: skillId,
        state: "enabled",
      });
    } catch (err) {
      log.warn({ err, skillId }, "Failed to auto-enable installed skill");
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to install skill");
    return { success: false, error: message };
  }
}

export async function uninstallSkill(
  skillId: string,
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  // Validate skill name to prevent path traversal while allowing namespaced slugs (org/name)
  const validNamespacedSlug =
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const validSimpleName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (
    skillId.includes("..") ||
    skillId.includes("\\") ||
    !(validSimpleName.test(skillId) || validNamespacedSlug.test(skillId))
  ) {
    return { success: false, error: "Invalid skill name" };
  }

  try {
    // Use shared managed-store logic for simple managed skill IDs
    const isManagedId = !validateManagedSkillId(skillId);
    if (isManagedId) {
      const result = deleteManagedSkill(skillId);
      if (!result.deleted) {
        return {
          success: false,
          error: result.error ?? "Failed to delete managed skill",
        };
      }
    } else {
      // Namespaced slug (org/name) — direct filesystem removal
      const skillDir = join(getWorkspaceSkillsDir(), skillId);
      if (!existsSync(skillDir)) {
        return { success: false, error: "Skill not found" };
      }
      rmSync(skillDir, { recursive: true });
      try {
        removeSkillsIndexEntry(skillId);
      } catch {
        /* best effort */
      }
    }

    // Clean config entry
    const raw = loadRawConfig();
    const skills = raw.skills as Record<string, unknown> | undefined;
    const entries = skills?.entries as Record<string, unknown> | undefined;
    if (entries?.[skillId]) {
      delete entries[skillId];
      saveConfigWithSuppression(raw, ctx);
    }

    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "uninstalled",
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to uninstall skill");
    return { success: false, error: message };
  }
}

export async function updateSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const result = await clawhubUpdate(skillId);
    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }
    // Reload skill catalog to pick up updated skill
    loadSkillCatalog();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update skill");
    return { success: false, error: message };
  }
}

export async function checkSkillUpdates(
  _ctx: SkillOperationContext,
): Promise<
  { success: true; data: unknown } | { success: false; error: string }
> {
  try {
    const updates = await clawhubCheckUpdates();
    return { success: true, data: updates };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to check for skill updates");
    return { success: false, error: message };
  }
}

export async function searchSkills(
  query: string,
  _ctx: SkillOperationContext,
): Promise<
  { success: true; data: unknown } | { success: false; error: string }
> {
  try {
    const result = await clawhubSearch(query);
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to search skills");
    return { success: false, error: message };
  }
}

export async function inspectSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): Promise<{ slug: string; data?: ClawhubInspectResult; error?: string }> {
  try {
    const result = await clawhubInspect(skillId);
    return {
      slug: skillId,
      ...(result.data ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to inspect skill");
    return { slug: skillId, error: message };
  }
}

export interface DraftResult {
  success: boolean;
  draft?: {
    skillId: string;
    name: string;
    description: string;
    emoji?: string;
    bodyMarkdown: string;
  };
  warnings?: string[];
  error?: string;
}

export async function draftSkill(
  params: { sourceText: string },
  _ctx: SkillOperationContext,
): Promise<DraftResult> {
  try {
    const warnings: string[] = [];
    const parsed = parseFrontmatter(params.sourceText);
    const body = parsed.body.trim() || params.sourceText.trim();

    let { skillId, name, description, emoji } = parsed;

    // Determine which fields still need filling
    const missing: string[] = [];
    if (!skillId) missing.push("skillId");
    if (!name) missing.push("name");
    if (!description) missing.push("description");
    if (!emoji) missing.push("emoji");

    // Attempt LLM generation for missing fields
    if (missing.length > 0) {
      let llmGenerated = false;
      try {
        const provider = getConfiguredProvider();
        if (provider) {
          const { signal, cleanup } = createTimeout(LLM_DRAFT_TIMEOUT_MS);
          try {
            const prompt = [
              "Given the following skill body text, generate metadata for a managed skill.",
              `Return ONLY valid JSON with these fields: ${missing.join(", ")}.`,
              "Field descriptions:",
              "- skillId: a short kebab-case identifier (lowercase, alphanumeric + hyphens/dots/underscores, max 50 chars, must start with a letter or digit)",
              "- name: a human-readable name (max 100 chars)",
              "- description: a brief one-line description (max 200 chars)",
              "- emoji: a single emoji character representing the skill",
              "",
              "Skill body:",
              body.slice(0, 2000),
            ].join("\n");

            const response = await provider.sendMessage(
              [userMessage(prompt)],
              [],
              undefined,
              {
                config: { modelIntent: "latency-optimized", max_tokens: 256 },
                signal,
              },
            );
            cleanup();

            const responseText = extractText(response);
            // Extract JSON from response (handle markdown code fences)
            const jsonMatch = /\{[\s\S]*?\}/.exec(responseText);
            if (jsonMatch) {
              const generated = JSON.parse(jsonMatch[0]);
              if (typeof generated === "object" && generated) {
                if (!skillId && typeof generated.skillId === "string")
                  skillId = generated.skillId;
                if (!name && typeof generated.name === "string")
                  name = generated.name;
                if (!description && typeof generated.description === "string")
                  description = generated.description;
                if (!emoji && typeof generated.emoji === "string")
                  emoji = generated.emoji;
                llmGenerated = true;
              }
            }
          } catch (err) {
            cleanup();
            log.warn(
              { err },
              "LLM draft generation failed, falling back to heuristic",
            );
            warnings.push(
              "LLM draft generation failed, used heuristic fallback",
            );
          }
        } else {
          warnings.push("No LLM provider available, used heuristic fallback");
        }
      } catch (err) {
        log.warn({ err }, "Provider resolution failed for draft generation");
        warnings.push("Provider resolution failed, used heuristic fallback");
      }

      // Fall back to heuristic for any fields still missing
      if (!skillId || !name || !description || !emoji) {
        const heuristic = heuristicDraft(body);
        if (!skillId) {
          skillId = heuristic.skillId;
          if (!llmGenerated) warnings.push("skillId derived from heuristic");
        }
        if (!name) {
          name = heuristic.name;
          if (!llmGenerated) warnings.push("name derived from heuristic");
        }
        if (!description) {
          description = heuristic.description;
          if (!llmGenerated)
            warnings.push("description derived from heuristic");
        }
        if (!emoji) {
          emoji = heuristic.emoji;
        }
      }
    }

    // Normalize skillId to valid managed-skill slug format
    const originalId = skillId!;
    skillId = toSkillSlug(originalId);
    if (!skillId) skillId = "untitled-skill";
    if (skillId !== originalId) {
      warnings.push(`skillId normalized from "${originalId}" to "${skillId}"`);
    }

    // Final validation pass
    const validationError = validateManagedSkillId(skillId);
    if (validationError) {
      skillId =
        toSkillSlug(skillId.replace(/[^a-z0-9]/g, "-")) || "untitled-skill";
      warnings.push(
        `skillId re-normalized due to validation: ${validationError}`,
      );
    }

    return {
      success: true,
      draft: {
        skillId: skillId!,
        name: name!,
        description: description!,
        emoji,
        bodyMarkdown: body,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to generate skill draft");
    return { success: false, error: message };
  }
}

export interface CreateSkillParams {
  skillId: string;
  name: string;
  description: string;
  emoji?: string;
  bodyMarkdown: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  overwrite?: boolean;
}

export async function createSkill(
  params: CreateSkillParams,
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const result = createManagedSkill({
      id: params.skillId,
      name: params.name,
      description: params.description,
      emoji: params.emoji,
      bodyMarkdown: params.bodyMarkdown,
      userInvocable: params.userInvocable,
      disableModelInvocation: params.disableModelInvocation,
      overwrite: params.overwrite,
    });

    if (!result.created) {
      return {
        success: false,
        error: result.error ?? "Failed to create managed skill",
      };
    }

    // Auto-enable the newly created skill
    try {
      const raw = loadRawConfig();
      ensureSkillEntry(raw, params.skillId).enabled = true;
      saveConfigWithSuppression(raw, ctx);
      ctx.broadcast({
        type: "skills_state_changed",
        name: params.skillId,
        state: "enabled",
      });
    } catch (err) {
      log.warn(
        { err, skillId: params.skillId },
        "Failed to auto-enable created skill",
      );
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to create skill");
    return { success: false, error: message };
  }
}

// ─── IPC handlers (thin wrappers) ───────────────────────────────────────────

export function handleSkillsList(ctx: HandlerContext): void {
  const skills = listSkills(ctx);
  ctx.send({ type: "skills_list_response", skills });
}

export function handleSkillsEnable(
  msg: SkillsEnableRequest,
  ctx: HandlerContext,
): void {
  const result = enableSkill(msg.name, ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "enable",
    ...result,
  });
}

export function handleSkillsDisable(
  msg: SkillsDisableRequest,
  ctx: HandlerContext,
): void {
  const result = disableSkill(msg.name, ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "disable",
    ...result,
  });
}

export function handleSkillsConfigure(
  msg: SkillsConfigureRequest,
  ctx: HandlerContext,
): void {
  const result = configureSkill(
    msg.name,
    { env: msg.env, apiKey: msg.apiKey, config: msg.config },
    ctx,
  );
  ctx.send({
    type: "skills_operation_response",
    operation: "configure",
    ...result,
  });
}

export async function handleSkillsInstall(
  msg: SkillsInstallRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await installSkill(
    { slug: msg.slug, version: msg.version },
    ctx,
  );
  ctx.send({
    type: "skills_operation_response",
    operation: "install",
    ...result,
  });
}

export async function handleSkillsUninstall(
  msg: SkillsUninstallRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await uninstallSkill(msg.name, ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "uninstall",
    ...result,
  });
}

export async function handleSkillsUpdate(
  msg: SkillsUpdateRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await updateSkill(msg.name, ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "update",
    ...result,
  });
}

export async function handleSkillsCheckUpdates(
  _msg: SkillsCheckUpdatesRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await checkSkillUpdates(ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "check_updates",
    ...result,
  });
}

export async function handleSkillsSearch(
  msg: SkillsSearchRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await searchSkills(msg.query, ctx);
  ctx.send({
    type: "skills_operation_response",
    operation: "search",
    ...result,
  });
}

export async function handleSkillsInspect(
  msg: SkillsInspectRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await inspectSkill(msg.slug, ctx);
  ctx.send({
    type: "skills_inspect_response",
    ...result,
  });
}

export async function handleSkillDetail(
  msg: SkillDetailRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = loadSkillBySelector(msg.skillId);
  if (result.skill) {
    const icon = await ensureSkillIcon(
      result.skill.directoryPath,
      result.skill.displayName,
      result.skill.description,
    );
    ctx.send({
      type: "skill_detail_response",
      skillId: result.skill.id,
      body: result.skill.body,
      ...(icon ? { icon } : {}),
    });
  } else {
    ctx.send({
      type: "skill_detail_response",
      skillId: msg.skillId,
      body: "",
      error: result.error ?? "Skill not found",
    });
  }
}

export async function handleSkillsDraft(
  msg: SkillsDraftRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await draftSkill({ sourceText: msg.sourceText }, ctx);
  ctx.send({ type: "skills_draft_response", ...result });
}

export async function handleSkillsCreate(
  msg: SkillsCreateRequest,
  ctx: HandlerContext,
): Promise<void> {
  const result = await createSkill(
    {
      skillId: msg.skillId,
      name: msg.name,
      description: msg.description,
      emoji: msg.emoji,
      bodyMarkdown: msg.bodyMarkdown,
      userInvocable: msg.userInvocable,
      disableModelInvocation: msg.disableModelInvocation,
      overwrite: msg.overwrite,
    },
    ctx,
  );
  ctx.send({
    type: "skills_operation_response",
    operation: "create",
    ...result,
  });
}
