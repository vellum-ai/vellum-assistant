/**
 * Authorize and execute a plugin-resident skill script.
 *
 * Plugin identity is taken only from the skill catalog `owner` descriptor
 * (install-directory basename). Caller-supplied plugin names, paths, and
 * environment values are ignored. The child receives a short-lived
 * invocation grant so `@vellumai/plugin-api` can resolve credentials under
 * that plugin's service only.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { PLUGIN_SKILL_INVOCATION_ENV } from "../plugin-api/plugin-skill-grant.js";
import { loadSkillCatalog, type SkillSummary } from "../config/skills.js";
import { findConversationOrSubagent } from "../daemon/conversation-registry.js";
import { conversationRevealNonce } from "../runtime/reveal-nonce.js";
import { buildSanitizedEnv } from "../tools/terminal/safe-env.js";
import { terminateProcessTree } from "../util/host-process.js";
import { getLogger } from "../util/logger.js";
import {
  issuePluginSkillGrant,
  revokePluginSkillGrant,
} from "./plugin-skill-invocation.js";

const log = getLogger("plugin-skill-script-runner");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

const ALLOWED_SCRIPT_ROOTS = new Set(["scripts", "tools"]);

export type PluginSkillScriptAuthFailure =
  | "missing_conversation"
  | "conversation_not_live"
  | "skill_not_found"
  | "not_plugin_owned"
  | "skill_not_active"
  | "invalid_script"
  | "invalid_nonce";

export interface AuthorizePluginSkillScriptInput {
  conversationId: string;
  skillId: string;
  script: string;
  revealNonce?: string;
}

export type AuthorizePluginSkillScriptResult =
  | {
      ok: true;
      skill: SkillSummary;
      pluginName: string;
      scriptPath: string;
      relativeScript: string;
    }
  | {
      ok: false;
      reason: PluginSkillScriptAuthFailure;
      message: string;
    };

export interface RunPluginSkillScriptInput
  extends AuthorizePluginSkillScriptInput {
  args?: string[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export type RunPluginSkillScriptResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number;
    }
  | {
      ok: false;
      reason: PluginSkillScriptAuthFailure | "spawn_failed";
      message: string;
    };

function normalizeRelativeScript(script: string): string | undefined {
  if (typeof script !== "string" || script.trim().length === 0) {
    return undefined;
  }
  const normalized = script.replace(/\\/g, "/").trim();
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return undefined;
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) {
    return undefined;
  }
  if (parts.some((part) => part === "." || part === "..")) {
    return undefined;
  }
  if (!ALLOWED_SCRIPT_ROOTS.has(parts[0] ?? "")) {
    return undefined;
  }
  return parts.join("/");
}

function resolveAuthorizedScript(
  skillDir: string,
  script: string,
): { absolute: string; relative: string } | undefined {
  const relativeScript = normalizeRelativeScript(script);
  if (relativeScript === undefined) {
    return undefined;
  }
  const skillRoot = resolve(skillDir);
  const absolute = resolve(skillRoot, relativeScript);
  const rel = relative(skillRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return undefined;
  }
  if (!existsSync(absolute)) {
    return undefined;
  }
  try {
    if (!statSync(absolute).isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { absolute, relative: relativeScript };
}

/**
 * Decide whether this conversation may run `script` for `skillId`.
 * Plugin identity is read from the catalog only.
 */
export function authorizePluginSkillScript(
  input: AuthorizePluginSkillScriptInput,
): AuthorizePluginSkillScriptResult {
  if (
    typeof input.conversationId !== "string" ||
    input.conversationId.length === 0
  ) {
    return {
      ok: false,
      reason: "missing_conversation",
      message:
        "A live conversation is required to run a plugin-resident skill script.",
    };
  }
  if (typeof input.skillId !== "string" || input.skillId.length === 0) {
    return {
      ok: false,
      reason: "skill_not_found",
      message: "Skill id is required.",
    };
  }

  if (input.revealNonce !== undefined) {
    if (
      typeof input.revealNonce !== "string" ||
      input.revealNonce.length === 0 ||
      input.revealNonce !== conversationRevealNonce(input.conversationId)
    ) {
      return {
        ok: false,
        reason: "invalid_nonce",
        message:
          "Plugin skill script invocation is not authorized for this conversation.",
      };
    }
  }

  const conversation = findConversationOrSubagent(input.conversationId);
  if (!conversation) {
    return {
      ok: false,
      reason: "conversation_not_live",
      message: `Conversation "${input.conversationId}" is not live in this assistant.`,
    };
  }

  const skill = loadSkillCatalog().find((entry) => entry.id === input.skillId);
  if (!skill) {
    return {
      ok: false,
      reason: "skill_not_found",
      message: `Skill "${input.skillId}" was not found in the catalog.`,
    };
  }
  if (skill.owner?.kind !== "plugin" || skill.owner.id.length === 0) {
    return {
      ok: false,
      reason: "not_plugin_owned",
      message: `Skill "${input.skillId}" is not a plugin-resident skill.`,
    };
  }
  if (!conversation.skillProjectionState.has(input.skillId)) {
    return {
      ok: false,
      reason: "skill_not_active",
      message: `Skill "${input.skillId}" is not active in this conversation.`,
    };
  }

  const resolved = resolveAuthorizedScript(skill.directoryPath, input.script);
  if (!resolved) {
    return {
      ok: false,
      reason: "invalid_script",
      message:
        "Script must be an existing file under the skill's scripts/ or tools/ directory.",
    };
  }

  return {
    ok: true,
    skill,
    pluginName: skill.owner.id,
    scriptPath: resolved.absolute,
    relativeScript: resolved.relative,
  };
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (timeoutMs < 1) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS);
}

/**
 * Authorize the invocation, mint a grant, and exec the script as a child
 * of the assistant. The grant is never placed on argv and is revoked when
 * the child exits.
 */
export async function runPluginSkillScript(
  input: RunPluginSkillScriptInput,
): Promise<RunPluginSkillScriptResult> {
  const authorized = authorizePluginSkillScript(input);
  if (!authorized.ok) {
    return authorized;
  }

  const issued = issuePluginSkillGrant({
    conversationId: input.conversationId,
    pluginName: authorized.pluginName,
    skillId: input.skillId,
  });

  const timeoutMs = clampTimeoutMs(input.timeoutMs);
  const env = buildSanitizedEnv();
  env[PLUGIN_SKILL_INVOCATION_ENV] = issued.token;
  env.__CONVERSATION_ID = input.conversationId;
  delete env.__REVEAL_NONCE;

  const args = [authorized.relativeScript, ...(input.args ?? [])];

  log.info(
    {
      conversationId: input.conversationId,
      skillId: input.skillId,
      pluginName: authorized.pluginName,
      script: authorized.relativeScript,
    },
    "Running plugin-resident skill script",
  );

  try {
    return await new Promise<RunPluginSkillScriptResult>((resolvePromise) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let settled = false;

      const finish = (result: RunPluginSkillScriptResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise(result);
      };

      const child = spawn(process.execPath, args, {
        cwd: authorized.skill.directoryPath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child);
      }, timeoutMs);

      const onAbort = () => {
        terminateProcessTree(child);
      };
      if (input.abortSignal) {
        if (input.abortSignal.aborted) {
          terminateProcessTree(child);
        } else {
          input.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout?.on("data", (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on("data", (data: Buffer) => stderrChunks.push(data));

      child.on("close", (code) => {
        clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", onAbort);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        if (timedOut) {
          finish({
            ok: true,
            stdout,
            stderr:
              stderr.length > 0
                ? `${stderr}\nScript timed out after ${timeoutMs}ms`
                : `Script timed out after ${timeoutMs}ms`,
            exitCode: code ?? 124,
          });
          return;
        }
        finish({
          ok: true,
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        input.abortSignal?.removeEventListener("abort", onAbort);
        finish({
          ok: false,
          reason: "spawn_failed",
          message: `Failed to start plugin skill script: ${err.message}`,
        });
      });
    });
  } finally {
    revokePluginSkillGrant(issued.token);
  }
}
