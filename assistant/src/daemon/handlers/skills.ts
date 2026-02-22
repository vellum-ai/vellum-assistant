import * as net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, loadRawConfig, saveRawConfig, invalidateConfigCache } from '../../config/loader.js';
import { loadSkillCatalog, loadSkillBySelector, ensureSkillIcon } from '../../config/skills.js';
import { resolveSkillStates } from '../../config/skill-state.js';
import { getWorkspaceSkillsDir } from '../../util/platform.js';
import { clawhubInstall, clawhubUpdate, clawhubSearch, clawhubCheckUpdates, clawhubInspect } from '../../skills/clawhub.js';
import { removeSkillsIndexEntry, deleteManagedSkill, validateManagedSkillId } from '../../skills/managed-store.js';
import type {
  SkillDetailRequest,
  SkillsEnableRequest,
  SkillsDisableRequest,
  SkillsConfigureRequest,
  SkillsInstallRequest,
  SkillsUninstallRequest,
  SkillsUpdateRequest,
  SkillsCheckUpdatesRequest,
  SkillsSearchRequest,
  SkillsInspectRequest,
} from '../ipc-protocol.js';
import { log, CONFIG_RELOAD_DEBOUNCE_MS, ensureSkillEntry, defineHandlers, type HandlerContext } from './shared.js';

export function handleSkillsList(socket: net.Socket, ctx: HandlerContext): void {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  const skills = resolved.map((r) => ({
    id: r.summary.id,
    name: r.summary.name,
    description: r.summary.description,
    emoji: r.summary.emoji,
    homepage: r.summary.homepage,
    source: r.summary.source as 'bundled' | 'managed' | 'workspace' | 'clawhub' | 'extra',
    state: (r.state === 'degraded' ? 'enabled' : r.state) as 'enabled' | 'disabled' | 'available',
    degraded: r.degraded,
    missingRequirements: r.missingRequirements,
    updateAvailable: false,
    userInvocable: r.summary.userInvocable,
  }));

  ctx.send(socket, { type: 'skills_list_response', skills });
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

    ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'enable',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'enabled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to enable skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'enable',
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

    ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'disable',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'disabled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to disable skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'disable',
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

    ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

    ctx.updateConfigFingerprint();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'configure',
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to configure skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'configure',
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
    const result = await clawhubInstall(msg.slug, { version: msg.version });
    if (!result.success) {
      ctx.send(socket, {
        type: 'skills_operation_response',
        operation: 'install',
        success: false,
        error: result.error ?? 'Unknown error',
      });
      return;
    }

    // Reload skill catalog so the newly installed skill is picked up
    loadSkillCatalog();

    // Auto-enable the newly installed skill so it's immediately usable.
    // Use basename of slug to match the catalog ID (directory basename), since
    // install slugs can be namespaced (e.g. "org/name") but skill state keys use
    // the bare directory name.
    const rawId = result.skillName ?? msg.slug;
    const skillId = rawId.includes('/') ? rawId.split('/').pop()! : rawId;
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
      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);
      ctx.updateConfigFingerprint();
    } catch (err) {
      log.warn({ err, skillId }, 'Failed to auto-enable installed skill');
    }

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'install',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: skillId,
      state: 'enabled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to install skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'install',
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
  const validNamespacedSlug = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const validSimpleName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (msg.name.includes('..') || msg.name.includes('\\') || !(validSimpleName.test(msg.name) || validNamespacedSlug.test(msg.name))) {
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: false,
      error: 'Invalid skill name',
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
          type: 'skills_operation_response',
          operation: 'uninstall',
          success: false,
          error: result.error ?? 'Failed to delete managed skill',
        });
        return;
      }
    } else {
      // Namespaced slug (org/name) — direct filesystem removal
      const skillDir = join(getWorkspaceSkillsDir(), msg.name);
      if (!existsSync(skillDir)) {
        ctx.send(socket, {
          type: 'skills_operation_response',
          operation: 'uninstall',
          success: false,
          error: 'Skill not found',
        });
        return;
      }
      rmSync(skillDir, { recursive: true });
      try { removeSkillsIndexEntry(msg.name); } catch { /* best effort */ }
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

      ctx.debounceTimers.schedule('__suppress_reset__', () => { ctx.setSuppressConfigReload(false); }, CONFIG_RELOAD_DEBOUNCE_MS);

      ctx.updateConfigFingerprint();
    }

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
      success: true,
    });
    ctx.broadcast({
      type: 'skills_state_changed',
      name: msg.name,
      state: 'uninstalled',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to uninstall skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'uninstall',
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
        type: 'skills_operation_response',
        operation: 'update',
        success: false,
        error: result.error ?? 'Unknown error',
      });
      return;
    }

    // Reload skill catalog to pick up updated skill
    loadSkillCatalog();

    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'update',
      success: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to update skill');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'update',
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
      type: 'skills_operation_response',
      operation: 'check_updates',
      success: true,
      data: updates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to check for skill updates');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'check_updates',
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
      type: 'skills_operation_response',
      operation: 'search',
      success: true,
      data: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to search skills');
    ctx.send(socket, {
      type: 'skills_operation_response',
      operation: 'search',
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
      type: 'skills_inspect_response',
      slug: msg.slug,
      ...(result.data ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to inspect skill');
    ctx.send(socket, {
      type: 'skills_inspect_response',
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
    const icon = await ensureSkillIcon(result.skill.directoryPath, result.skill.name, result.skill.description);
    ctx.send(socket, {
      type: 'skill_detail_response',
      skillId: result.skill.id,
      body: result.skill.body,
      ...(icon ? { icon } : {}),
    });
  } else {
    ctx.send(socket, {
      type: 'skill_detail_response',
      skillId: msg.skillId,
      body: '',
      error: result.error ?? 'Skill not found',
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
});
