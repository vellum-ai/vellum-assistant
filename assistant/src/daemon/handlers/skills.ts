import { existsSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";

import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { resolveSkillStates } from "../../config/skill-state.js";
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
} from "../ipc-protocol.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  defineHandlers,
  ensureSkillEntry,
  type HandlerContext,
  log,
} from "./shared.js";

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

export function handleSkillsList(
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  const skills = resolved.map((r) => ({
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

  ctx.send(socket, { type: "skills_list_response", skills });
}

export function handleSkillsEnable(
  msg: SkillsEnableRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, msg.name).enabled = true;

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

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "enable",
      success: true,
    });
    ctx.broadcast({
      type: "skills_state_changed",
      name: msg.name,
      state: "enabled",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to enable skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "enable",
      success: false,
      error: message,
    });
  }
}

export function handleSkillsDisable(
  msg: SkillsDisableRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, msg.name).enabled = false;

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

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "disable",
      success: true,
    });
    ctx.broadcast({
      type: "skills_state_changed",
      name: msg.name,
      state: "disabled",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to disable skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "disable",
      success: false,
      error: message,
    });
  }
}

export function handleSkillsConfigure(
  msg: SkillsConfigureRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const raw = loadRawConfig();

    const entry = ensureSkillEntry(raw, msg.name);
    if (msg.env) {
      entry.env = msg.env;
    }
    if (msg.apiKey !== undefined) {
      entry.apiKey = msg.apiKey;
    }
    if (msg.config) {
      entry.config = msg.config;
    }

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

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "configure",
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to configure skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "configure",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsInstall(
  msg: SkillsInstallRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    // Bundled skills are already available — no install needed
    const catalog = loadSkillCatalog();
    const bundled = catalog.find(
      (s) => s.id === msg.slug && s.source === "bundled",
    );
    if (bundled) {
      // Auto-enable the bundled skill so it's immediately usable
      let autoEnabled = false;
      try {
        const raw = loadRawConfig();
        ensureSkillEntry(raw, msg.slug).enabled = true;
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
        autoEnabled = true;
      } catch (err) {
        log.warn(
          { err, skillId: msg.slug },
          "Failed to auto-enable bundled skill",
        );
      }

      ctx.send(socket, {
        type: "skills_operation_response",
        operation: "install",
        success: true,
      });
      if (autoEnabled) {
        ctx.broadcast({
          type: "skills_state_changed",
          name: msg.slug,
          state: "enabled",
        });
      }
      return;
    }

    // Install from clawhub (community)
    const result = await clawhubInstall(msg.slug, { version: msg.version });
    if (!result.success) {
      ctx.send(socket, {
        type: "skills_operation_response",
        operation: "install",
        success: false,
        error: result.error ?? "Unknown error",
      });
      return;
    }
    const rawId = result.skillName ?? msg.slug;
    const skillId = rawId.includes("/") ? rawId.split("/").pop()! : rawId;

    // Reload skill catalog so the newly installed skill is picked up
    loadSkillCatalog();

    // Auto-enable the newly installed skill so it's immediately usable.
    let autoEnabled = false;
    try {
      const raw = loadRawConfig();
      ensureSkillEntry(raw, skillId).enabled = true;
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
      autoEnabled = true;
    } catch (err) {
      log.warn({ err, skillId }, "Failed to auto-enable installed skill");
    }

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "install",
      success: true,
    });
    if (autoEnabled) {
      ctx.broadcast({
        type: "skills_state_changed",
        name: skillId,
        state: "enabled",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to install skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "install",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsUninstall(
  msg: SkillsUninstallRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  // Validate skill name to prevent path traversal while allowing namespaced slugs (org/name)
  const validNamespacedSlug =
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const validSimpleName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (
    msg.name.includes("..") ||
    msg.name.includes("\\") ||
    !(validSimpleName.test(msg.name) || validNamespacedSlug.test(msg.name))
  ) {
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "uninstall",
      success: false,
      error: "Invalid skill name",
    });
    return;
  }

  try {
    // Use shared managed-store logic for simple managed skill IDs
    const isManagedId = !validateManagedSkillId(msg.name);
    if (isManagedId) {
      const result = deleteManagedSkill(msg.name);
      if (!result.deleted) {
        ctx.send(socket, {
          type: "skills_operation_response",
          operation: "uninstall",
          success: false,
          error: result.error ?? "Failed to delete managed skill",
        });
        return;
      }
    } else {
      // Namespaced slug (org/name) — direct filesystem removal
      const skillDir = join(getWorkspaceSkillsDir(), msg.name);
      if (!existsSync(skillDir)) {
        ctx.send(socket, {
          type: "skills_operation_response",
          operation: "uninstall",
          success: false,
          error: "Skill not found",
        });
        return;
      }
      rmSync(skillDir, { recursive: true });
      try {
        removeSkillsIndexEntry(msg.name);
      } catch {
        /* best effort */
      }
    }

    // Clean config entry
    const raw = loadRawConfig();
    const skills = raw.skills as Record<string, unknown> | undefined;
    const entries = skills?.entries as Record<string, unknown> | undefined;
    if (entries?.[msg.name]) {
      delete entries[msg.name];

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

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "uninstall",
      success: true,
    });
    ctx.broadcast({
      type: "skills_state_changed",
      name: msg.name,
      state: "uninstalled",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to uninstall skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "uninstall",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsUpdate(
  msg: SkillsUpdateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubUpdate(msg.name);
    if (!result.success) {
      ctx.send(socket, {
        type: "skills_operation_response",
        operation: "update",
        success: false,
        error: result.error ?? "Unknown error",
      });
      return;
    }

    // Reload skill catalog to pick up updated skill
    loadSkillCatalog();

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "update",
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "update",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsCheckUpdates(
  _msg: SkillsCheckUpdatesRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const updates = await clawhubCheckUpdates();
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "check_updates",
      success: true,
      data: updates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to check for skill updates");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "check_updates",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsSearch(
  msg: SkillsSearchRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubSearch(msg.query);

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "search",
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to search skills");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "search",
      success: false,
      error: message,
    });
  }
}

export async function handleSkillsInspect(
  msg: SkillsInspectRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = await clawhubInspect(msg.slug);
    ctx.send(socket, {
      type: "skills_inspect_response",
      slug: msg.slug,
      ...(result.data ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to inspect skill");
    ctx.send(socket, {
      type: "skills_inspect_response",
      slug: msg.slug,
      error: message,
    });
  }
}

export async function handleSkillDetail(
  msg: SkillDetailRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const result = loadSkillBySelector(msg.skillId);
  if (result.skill) {
    const icon = await ensureSkillIcon(
      result.skill.directoryPath,
      result.skill.displayName,
      result.skill.description,
    );
    ctx.send(socket, {
      type: "skill_detail_response",
      skillId: result.skill.id,
      body: result.skill.body,
      ...(icon ? { icon } : {}),
    });
  } else {
    ctx.send(socket, {
      type: "skill_detail_response",
      skillId: msg.skillId,
      body: "",
      error: result.error ?? "Skill not found",
    });
  }
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

// ─── Draft handler ───────────────────────────────────────────────────────────

const LLM_DRAFT_TIMEOUT_MS = 15_000;

export async function handleSkillsDraft(
  msg: SkillsDraftRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const warnings: string[] = [];
    const parsed = parseFrontmatter(msg.sourceText);
    const body = parsed.body.trim() || msg.sourceText.trim();

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

    ctx.send(socket, {
      type: "skills_draft_response",
      success: true,
      draft: {
        skillId: skillId!,
        name: name!,
        description: description!,
        emoji,
        bodyMarkdown: body,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to generate skill draft");
    ctx.send(socket, {
      type: "skills_draft_response",
      success: false,
      error: message,
    });
  }
}

// ─── Create handler ──────────────────────────────────────────────────────────

export async function handleSkillsCreate(
  msg: SkillsCreateRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const result = createManagedSkill({
      id: msg.skillId,
      name: msg.name,
      description: msg.description,
      emoji: msg.emoji,
      bodyMarkdown: msg.bodyMarkdown,
      userInvocable: msg.userInvocable,
      disableModelInvocation: msg.disableModelInvocation,
      overwrite: msg.overwrite,
    });

    if (!result.created) {
      ctx.send(socket, {
        type: "skills_operation_response",
        operation: "create",
        success: false,
        error: result.error ?? "Failed to create managed skill",
      });
      return;
    }

    // Auto-enable the newly created skill
    let autoEnabled = false;
    try {
      const raw = loadRawConfig();
      ensureSkillEntry(raw, msg.skillId).enabled = true;
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
      autoEnabled = true;
    } catch (err) {
      log.warn(
        { err, skillId: msg.skillId },
        "Failed to auto-enable created skill",
      );
    }

    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "create",
      success: true,
    });
    if (autoEnabled) {
      ctx.broadcast({
        type: "skills_state_changed",
        name: msg.skillId,
        state: "enabled",
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to create skill");
    ctx.send(socket, {
      type: "skills_operation_response",
      operation: "create",
      success: false,
      error: message,
    });
  }
}

export const skillHandlers = defineHandlers({
  skills_list: (_msg, socket, ctx) => handleSkillsList(socket, ctx),
  skill_detail: handleSkillDetail,
  skills_enable: handleSkillsEnable,
  skills_disable: handleSkillsDisable,
  skills_configure: handleSkillsConfigure,
  skills_install: handleSkillsInstall,
  skills_uninstall: handleSkillsUninstall,
  skills_update: handleSkillsUpdate,
  skills_check_updates: handleSkillsCheckUpdates,
  skills_search: handleSkillsSearch,
  skills_inspect: handleSkillsInspect,
  skills_draft: handleSkillsDraft,
  skills_create: handleSkillsCreate,
});
