import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import {
  loadSkillCatalog,
  resolveSkillSelector,
  type SkillSummary,
} from "../config/skills.js";
import { ipcClassifyRisk } from "../ipc/gateway-client.js";
import {
  MEMORY_RETROSPECTIVE_ORIGIN,
  SKILL_MANAGEMENT_SKILL_ID,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { indexCatalogById, validateIncludes } from "../skills/include-graph.js";
import { getSkillRoots } from "../skills/path-classifier.js";
import { computeTransitiveSkillVersionHash } from "../skills/transitive-version-hash.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { ManifestOverride } from "../tools/execution-target.js";
import { getTool, getToolOwner, resolveTool } from "../tools/registry.js";
import { resolveRealPath } from "../tools/shared/filesystem/path-policy.js";
import type { Tool } from "../tools/types.js";
import {
  getDeprecatedDir,
  getMonitoringDataDir,
  getProtectedDir,
  getWorkspaceDir,
  getWorkspaceHooksDir,
  getWorkspacePluginsDir,
  getWorkspaceRoutesDir,
  getWorkspaceToolsDir,
  getWorkspaceWorkflowsDir,
} from "../util/platform.js";
import {
  type ApprovalContext,
  DefaultApprovalPolicy,
} from "./approval-policy.js";
import { buildChannelPermissionCellQuery } from "./channel-permission-query.js";
import {
  getAutoApproveThreshold,
  refreshAutoApproveThreshold,
} from "./gateway-threshold-reader.js";
import {
  type PermissionCheckResult,
  type PolicyContext,
  RiskLevel,
  type ScopeOption,
} from "./types.js";
import {
  isPathWithinWorkspaceRoot,
  isWorkspaceScopedInvocation,
  resolveSandboxBase,
} from "./workspace-policy.js";

/**
 * One gateway classification as the daemon carries it: the `classify_risk`
 * response with `risk` mapped onto the daemon's {@link RiskLevel} as `level`.
 * Produced once per tool invocation by {@link classifyRisk} and handed down
 * through `checkPermission` and {@link check}; the daemon keeps no memo of
 * it, so a trust-rule, config, or skill change is reflected on the next call.
 */
export type RiskClassificationWithMeta = Omit<
  ClassifyRiskIpcResponse,
  "risk"
> & {
  level: RiskLevel;
};

// ── Approval policy singleton ────────────────────────────────────────────────
const defaultApprovalPolicy = new DefaultApprovalPolicy();

function getStringField(
  input: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/**
 * Resolve a skill selector to its id and version hash. The version hash
 * is always computed from disk so that untrusted input cannot spoof a
 * pre-approved hash. If disk computation fails, only the bare id is returned.
 */
function resolveSkillIdAndHash(
  selector: string,
): { id: string; versionHash?: string } | null {
  const resolved = resolveSkillSelector(selector);
  if (!resolved.skill) {
    return null;
  }

  try {
    const hash = computeSkillVersionHash(resolved.skill.directoryPath);
    return { id: resolved.skill.id, versionHash: hash };
  } catch {
    return { id: resolved.skill.id };
  }
}

/**
 * Resolve whether the skill that owns this tool is bundled (first-party).
 * Returns false when the tool has no owning skill or the skill is not in
 * the catalog. Derived from `loadSkillCatalog()` at check time so the
 * answer reflects current catalog truth (managed overrides flip the bit
 * without needing to re-register tools). Owner is looked up from the tool
 * registry (`getToolOwner(name)`) rather than read from the `Tool` object,
 * since ownership lives on the registry, not on the tool itself.
 */
export function isToolOwnerSkillBundled(tool: Tool | undefined): boolean {
  if (!tool) {
    return false;
  }
  const owner = getToolOwner(tool.name);
  if (owner?.kind !== "skill") {
    return false;
  }
  const skill = loadSkillCatalog().find((s) => s.id === owner.id);
  return skill?.bundled ?? false;
}

/**
 * Whether a catalog entry carries parsed inline command expansions, which
 * execute shell commands at load time. Returns false for an absent entry.
 */
function summaryHasInlineExpansions(skill: SkillSummary | undefined): boolean {
  return (
    skill?.inlineCommandExpansions != null &&
    skill.inlineCommandExpansions.length > 0
  );
}

/**
 * Check whether a skill (by id) has parsed inline command expansions.
 * Returns false when the skill is not found in the catalog.
 */
function hasInlineExpansions(skillId: string): boolean {
  const catalog = loadSkillCatalog();
  return summaryHasInlineExpansions(catalog.find((s) => s.id === skillId));
}

/**
 * The id of the skill a `skill_load` invocation targets, or `null` for any
 * other tool, a blank selector, or a selector that names no skill in the
 * local catalog.
 */
function resolveSkillLoadTargetId(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (toolName !== "skill_load") {
    return null;
  }
  const selector = getStringField(input, "skill").trim();
  if (!selector) {
    return null;
  }
  return resolveSkillIdAndHash(selector)?.id ?? null;
}

/**
 * Whether this invocation is an inline-command ("dynamic") skill load: a
 * `skill_load` whose resolved skill carries inline command expansions,
 * which execute shell commands at load time via child_process.spawn.
 * Exported for the non-interactive guardian gate in
 * tools/permission-checker.ts — a prompted dynamic load must never be
 * silently auto-approved without a human present. (A pinned trust rule
 * that covers the load lowers its classified risk upstream, so covered
 * loads resolve to "allow" before that gate is reached.)
 */
export function isDynamicSkillLoadInvocation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const skillId = resolveSkillLoadTargetId(toolName, input);
  return skillId !== null && hasInlineExpansions(skillId);
}

/**
 * Whether a `skill_load` invocation is a pure read: the target skill and every
 * skill reachable through its `includes` graph are installed locally and carry
 * no inline command expansions.
 *
 * The whole graph matters because the load executor (tools/skills/load.ts)
 * auto-installs missing includes from the remote catalog
 * (`autoInstallFromCatalog`) and renders inline command expansions for both the
 * target and its included children. So a missing include anywhere in the graph
 * writes to the workspace, an inline expansion anywhere in it executes shell,
 * and either makes the load something other than a read.
 *
 * Fails closed and never throws — an unresolvable selector, a target absent
 * from the catalog, a missing include, a cycle, or an unreadable catalog all
 * return false. Selector resolution and catalog reads both touch the
 * filesystem, so both sit inside the guard: callers include a synchronous
 * live-voice event callback where a throw would abort the rest of the frame's
 * dispatch. Exported for gates that must not proceed on anything capable of
 * writing local state.
 */
export function isInstalledStaticSkillLoad(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  try {
    const skillId = resolveSkillLoadTargetId(toolName, input);
    if (skillId === null) {
      return false;
    }
    const catalogIndex = indexCatalogById(loadSkillCatalog());
    if (!catalogIndex.has(skillId)) {
      return false;
    }
    // `validateIncludes` is the shared include-graph walk: it reports the first
    // missing child or cycle, and on success yields every transitively included
    // id in DFS order.
    const validation = validateIncludes(skillId, catalogIndex);
    if (!validation.ok) {
      return false;
    }
    return validation.visited.every(
      (id) => !summaryHasInlineExpansions(catalogIndex.get(id)),
    );
  } catch {
    return false;
  }
}

/**
 * Compute the transitive version hash for a skill, returning `undefined`
 * when computation fails (missing includes, cycle, etc.). The permission
 * layer falls back to the any-version candidate in that case.
 */
function computeTransitiveHashSafe(skillId: string): string | undefined {
  try {
    const catalog = loadSkillCatalog();
    const index = indexCatalogById(catalog);
    return computeTransitiveSkillVersionHash(skillId, index);
  } catch {
    return undefined;
  }
}

// ── IPC param builders ───────────────────────────────────────────────────────
// Build the classify_risk request for each tool family. These resolve
// assistant-local context (file paths, skill metadata, etc.) before
// forwarding to the gateway.

import type {
  ClassifyRiskFileContext,
  ClassifyRiskIpcParams,
  ClassifyRiskIpcResponse,
  ClassifyRiskSkillMetadata,
  RiskLevelValue,
} from "@vellumai/gateway-client";

function buildFileContext(): ClassifyRiskFileContext {
  const config = getConfig();
  // Canonicalize the protected directories via realpath so that a symlinked
  // component anywhere in their path still prefix-matches the canonicalized
  // target path computed in buildClassifyRiskParams. Both sides must be
  // symlink-resolved for the gateway's lexical prefix checks to be sound.
  const protectedDir = resolveRealPath(getProtectedDir());
  return {
    protectedDir,
    deprecatedDir: resolveRealPath(getDeprecatedDir()),
    hooksDir: resolveRealPath(getWorkspaceHooksDir()),
    pluginsDir: resolveRealPath(getWorkspacePluginsDir()),
    toolsDir: resolveRealPath(getWorkspaceToolsDir()),
    routesDir: resolveRealPath(getWorkspaceRoutesDir()),
    workflowsDir: resolveRealPath(getWorkspaceWorkflowsDir()),
    monitoringDir: resolveRealPath(getMonitoringDataDir()),
    actorTokenSigningKeyPath: join(protectedDir, "actor-token-signing-key"),
    skillSourceDirs: getSkillRoots(config.skills.load.extraDirs).map(
      resolveRealPath,
    ),
  };
}

/**
 * Canonicalize the security-sensitive path of a file tool invocation by
 * resolving symlinks before it is sent to the gateway risk classifier.
 *
 * The gateway classifies file risk by lexically prefix-matching the target
 * path against protected directories (skill source, hooks, plugins, the actor
 * token signing key). Lexical resolution alone does not follow symlinks, so a
 * symlink whose name looks benign but whose real target is a protected
 * directory would be under-classified and could skip the High-risk approval
 * prompt. Resolving symlinks here — on the daemon, which owns the workspace
 * filesystem — closes that gap while keeping the gateway free of filesystem
 * access (it cannot see the workspace in Docker mode).
 *
 * `resolveRealPath` falls back to the lexical path when the target lives on a
 * filesystem this process cannot see (e.g. host_file paths proxied to a remote
 * client), so this never regresses below today's lexical behavior.
 */
function resolveClassificationPath(
  filePath: string,
  workingDir: string,
  isHostTool: boolean,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  // Mirror the gateway classifier's lexical base: host tools resolve the path
  // as absolute/relative-to-cwd; sandbox tools apply the /workspace remap and
  // resolve against workingDir. Then follow symlinks so a benign-looking name
  // whose real target is a protected directory is still escalated.
  const base = isHostTool
    ? resolve(filePath)
    : resolveSandboxBase(filePath, workingDir);
  return resolveRealPath(base);
}

interface FileToolResolution {
  filePath: string;
  effectiveWorkingDir: string;
  isHostTool: boolean;
  resolvedPath?: string;
  /**
   * Symlink-canonicalized working dir for sandbox file tools, paired with
   * `resolvedPath` so the gateway's workspace-boundary check compares
   * canonical against canonical (a symlinked workspace prefix, e.g. macOS
   * /var → /private/var, must not read as an escape). Unset for host tools.
   */
  resolvedWorkingDir?: string;
  transferSandboxDestPath?: string;
  transferSandboxWorkingDir?: string;
  resolvedTransferDestPath?: string;
}

/**
 * Resolve the security-sensitive path(s) of a file tool invocation, including
 * symlink canonicalization, for the IPC params: file risk depends on the
 * symlink target, not the raw tool input.
 */
function resolveFileToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
): FileToolResolution {
  const isHostTool = toolName.startsWith("host_");
  let filePath: string;
  // For host_file_transfer to_sandbox, the file is written into the workspace
  // at dest_path — capture it (plus the sandbox working dir) so the gateway can
  // escalate writes that land in a code-injection sink, since `path` carries
  // the host-side source.
  let transferSandboxDestPath: string | undefined;
  let transferSandboxWorkingDir: string | undefined;
  if (toolName === "host_file_transfer") {
    // The security-sensitive host-side path is source_path when reading from
    // the host (to_sandbox), dest_path when writing to the host (to_host).
    const direction = getStringField(input, "direction");
    if (direction === "to_sandbox") {
      filePath = getStringField(input, "source_path");
      transferSandboxDestPath = getStringField(input, "dest_path");
      transferSandboxWorkingDir = workingDir ?? process.cwd();
    } else {
      filePath = getStringField(input, "dest_path");
    }
  } else {
    filePath = getStringField(input, "path", "file_path");
  }
  const effectiveWorkingDir = isHostTool ? "/" : (workingDir ?? process.cwd());
  return {
    filePath,
    effectiveWorkingDir,
    isHostTool,
    resolvedPath: resolveClassificationPath(
      filePath,
      effectiveWorkingDir,
      isHostTool,
    ),
    resolvedWorkingDir: isHostTool
      ? undefined
      : resolveRealPath(effectiveWorkingDir),
    transferSandboxDestPath,
    transferSandboxWorkingDir,
    // The to_sandbox destination is a workspace write — symlink-resolve it too
    // so it can't mask a code-injection sink.
    resolvedTransferDestPath:
      transferSandboxDestPath != null
        ? resolveClassificationPath(
            transferSandboxDestPath,
            transferSandboxWorkingDir ?? process.cwd(),
            false,
          )
        : undefined,
  };
}

function resolveSkillMetadata(
  selector: string,
): ClassifyRiskSkillMetadata | undefined {
  const resolved = resolveSkillIdAndHash(selector);
  if (!resolved) {
    return undefined;
  }

  const inlineExpansions = hasInlineExpansions(resolved.id);

  return {
    skillId: resolved.id,
    selector,
    versionHash: resolved.versionHash ?? "",
    transitiveHash: inlineExpansions
      ? computeTransitiveHashSafe(resolved.id)
      : undefined,
    hasInlineExpansions: inlineExpansions,
    isDynamic: inlineExpansions,
  };
}

function buildClassifyRiskParams(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  manifestOverride?: ManifestOverride,
  shell?: ClassifyRiskIpcParams["shell"],
): ClassifyRiskIpcParams {
  // ── Bash/host_bash ──
  if (toolName === "bash" || toolName === "host_bash") {
    // Count credential references attached to this invocation.
    let credentialRefCount: number | undefined;
    if (Array.isArray(input.credential_ids)) {
      const validIds = (input.credential_ids as unknown[]).filter(
        (id) => typeof id === "string" && id.length > 0,
      );
      if (validIds.length > 0) {
        credentialRefCount = validIds.length;
      }
    }

    return {
      tool: toolName,
      command: getStringField(input, "command"),
      shell,
      workingDir,
      workspaceRoot: getWorkspaceDir(),
      isContainerized: getIsContainerized(),
      networkMode:
        typeof input.network_mode === "string" ? input.network_mode : undefined,
      credentialRefCount,
    };
  }

  // ── File tools ──
  if (
    [
      "file_read",
      "file_write",
      "file_edit",
      "host_file_read",
      "host_file_write",
      "host_file_edit",
      "host_file_transfer",
    ].includes(toolName)
  ) {
    const resolved = resolveFileToolPaths(toolName, input, workingDir);
    return {
      tool: toolName,
      path: resolved.filePath,
      resolvedPath: resolved.resolvedPath,
      resolvedWorkingDir: resolved.resolvedWorkingDir,
      workingDir: resolved.effectiveWorkingDir,
      isContainerized: getIsContainerized(),
      fileContext: buildFileContext(),
      transferSandboxDestPath: resolved.transferSandboxDestPath,
      transferSandboxWorkingDir: resolved.transferSandboxWorkingDir,
      resolvedTransferDestPath: resolved.resolvedTransferDestPath,
    };
  }

  // ── Web tools ──
  if (["web_fetch", "network_request", "web_search"].includes(toolName)) {
    return {
      tool: toolName,
      url: getStringField(input, "url"),
      allowPrivateNetwork: input.allow_private_network === true,
    };
  }

  // ── Skill tools ──
  if (
    ["skill_load", "scaffold_managed_skill", "delete_managed_skill"].includes(
      toolName,
    )
  ) {
    const selector = getStringField(input, "skill", "skill_id").trim();
    return {
      tool: toolName,
      skill: selector,
      skillMetadata: selector ? resolveSkillMetadata(selector) : undefined,
    };
  }

  // ── Schedule tools ──
  if (toolName === "schedule_create" || toolName === "schedule_update") {
    return {
      tool: toolName,
      mode: getStringField(input, "mode") || undefined,
      script: getStringField(input, "script") || undefined,
    };
  }

  // ── Unknown tools ──
  // Forward the tool's registry default risk level so the gateway can use it
  // instead of hardcoding medium for unknown tools. When the tool is not in the
  // registry but a manifestOverride provides a risk, use that instead.
  const tool = getTool(toolName);
  let registryDefaultRisk: RiskLevelValue | undefined;
  if (tool) {
    registryDefaultRisk =
      tool.defaultRiskLevel === RiskLevel.Low
        ? "low"
        : tool.defaultRiskLevel === RiskLevel.High
          ? "high"
          : tool.defaultRiskLevel === RiskLevel.Medium
            ? "medium"
            : undefined;
  } else if (manifestOverride?.risk) {
    registryDefaultRisk = manifestOverride.risk;
  }
  return { tool: toolName, registryDefaultRisk };
}

// ── Risk string → RiskLevel mapping ──────────────────────────────────────────

function riskStringToLevel(risk: string): RiskLevel {
  switch (risk) {
    case "low":
      return RiskLevel.Low;
    case "medium":
      return RiskLevel.Medium;
    case "high":
      return RiskLevel.High;
    default:
      return RiskLevel.Medium;
  }
}

/**
 * Re-check bash sandbox auto-approve path args against the workspace root
 * with symlink resolution. The gateway's lexical check cannot follow
 * symlinks (no filesystem access), so the daemon resolves each path arg
 * through {@link isPathWithinWorkspaceRoot} (which uses realpathSync) and
 * revokes auto-approve if any escapes the workspace boundary. Runs on every
 * classification, so a symlink retargeted between two invocations of the
 * same command is caught on the second.
 */
function applyBashSymlinkEscapeCheck(
  result: RiskClassificationWithMeta,
  sandboxPathArgs?: string[],
): void {
  if (
    !result.sandboxAutoApprove ||
    !sandboxPathArgs ||
    sandboxPathArgs.length === 0
  ) {
    return;
  }
  const wsRoot = getWorkspaceDir();
  const escaped = sandboxPathArgs.some(
    (p) => !isPathWithinWorkspaceRoot(p, wsRoot),
  );
  if (escaped) {
    result.sandboxAutoApprove = false;
  }
}

export async function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  workingDir?: string,
  _preParsed?: unknown,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
  shell?: ClassifyRiskIpcParams["shell"],
): Promise<RiskClassificationWithMeta> {
  signal?.throwIfAborted();

  const ipcParams = buildClassifyRiskParams(
    toolName,
    input,
    workingDir,
    manifestOverride,
    shell,
  );
  const gatewayResult = await ipcClassifyRisk(ipcParams, signal);
  // A mid-retry cancellation should surface as an AbortError, not the
  // misleading fail-closed "gateway unreachable" message.
  signal?.throwIfAborted();

  if (!gatewayResult) {
    throw new Error(
      `Gateway IPC classify_risk failed for tool "${toolName}" — gateway is unreachable or returned an invalid response`,
    );
  }

  const { risk, ...carried } = gatewayResult;
  const result: RiskClassificationWithMeta = {
    ...carried,
    level: riskStringToLevel(risk),
  };

  // ── Symlink escape check for bash sandbox auto-approve ───────────────
  // The gateway checks bash path args against the workspace root
  // lexically (path.resolve) — it has no filesystem access to follow
  // symlinks. A symlink inside the workspace pointing outside (e.g.
  // `ln -s /etc /workspace/escape`) would pass the lexical check and
  // be auto-approved. Resolve the gateway-provided path args through
  // symlinks here and revoke auto-approve if any escapes the workspace.
  applyBashSymlinkEscapeCheck(result, gatewayResult.sandboxPathArgs);

  return result;
}

// ── Background memory-retrospective skill-authoring auto-grant ────────────────
// Skill scaffolding (`scaffold_managed_skill`, risk: high + allowlist-gated),
// finding similar skills (`find_similar_skills`), and loading the
// `skill-management` skill (`skill_load skill-management`, which exposes the
// scaffold tool) require an interactive approval. The memory-retrospective
// background job runs without any connected client, so it can never answer that
// prompt. The grant resolves these tools to ALLOW non-interactively, and ONLY
// when all of these hold:
//   - procedural-memory-as-skills is active (`policyContext.procToSkillsActive`,
//     precomputed by buildPolicyContext: the v3 tier is active — memory is on
//     and memory-v3 is live),
//   - the turn is the retrospective background source — guardian trust, `vellum`
//     source channel, `memory_retrospective` origin (set in
//     memory-retrospective-job.ts).
//
// The grant is intentionally narrow: it matches exactly these tools AND the
// retrospective origin on a v3-live assistant, so no interactive session, other
// origin, or non-v3-live install is affected.
function isRetrospectiveSkillAuthoringGrant(
  toolName: string,
  input: Record<string, unknown>,
  policyContext?: PolicyContext,
): boolean {
  if (
    policyContext?.procToSkillsActive !== true ||
    policyContext.requestOrigin !== MEMORY_RETROSPECTIVE_ORIGIN ||
    policyContext.trustClass !== "guardian" ||
    policyContext.sourceChannel !== "vellum"
  ) {
    return false;
  }
  if (toolName === "scaffold_managed_skill") {
    return true;
  }
  if (toolName === "find_similar_skills") {
    return true;
  }
  if (toolName === "skill_load") {
    return (
      getStringField(input, "skill", "skill_id").trim() ===
      SKILL_MANAGEMENT_SKILL_ID
    );
  }
  return false;
}

/**
 * Decide allow / prompt / deny for one tool invocation.
 *
 * `classification` is the invocation's gateway classification when the caller
 * already holds it (the executor classifies once, before its gates, and hands
 * it down through `checkPermission`); a caller without one gets a fresh
 * classification of the same input here.
 */
export async function check(
  toolName: string,
  input: Record<string, unknown>,
  workingDir: string,
  policyContext?: PolicyContext,
  manifestOverride?: ManifestOverride,
  signal?: AbortSignal,
  classification?: RiskClassificationWithMeta,
): Promise<PermissionCheckResult> {
  signal?.throwIfAborted();

  if (isRetrospectiveSkillAuthoringGrant(toolName, input, policyContext)) {
    return {
      decision: "allow",
      reason:
        "Memory retrospective background session: skill authoring auto-approved",
    };
  }

  classification ??= await classifyRisk(
    toolName,
    input,
    workingDir,
    undefined,
    manifestOverride,
    signal,
  );

  const { level: risk, reason: riskReason } = classification;

  // Use gateway-provided sandboxAutoApprove instead of evaluating locally.
  const hasSandboxAutoApprove = classification.sandboxAutoApprove ?? false;

  // Build approval context from local variables
  const tool = await resolveTool(toolName);
  const cellQuery = buildChannelPermissionCellQuery(policyContext);
  const threshold = await getAutoApproveThreshold(
    policyContext?.conversationId,
    policyContext?.executionContext,
    cellQuery,
    policyContext?.requesterContactId,
  );
  const approvalContext: ApprovalContext = {
    riskLevel: risk,
    toolName,
    isContainerized: getIsContainerized(),
    isWorkspaceScoped:
      risk === RiskLevel.Low
        ? isWorkspaceScopedInvocation(toolName, input, workingDir)
        : false,
    toolOrigin: getToolOwner(toolName)?.kind,
    isSkillBundled: isToolOwnerSkillBundled(tool),
    hasManifestOverride: !!manifestOverride,
    autoApproveUpTo: threshold,
    hasSandboxAutoApprove,
  };

  // Delegate the allow/prompt/deny decision to the approval policy
  let approvalDecision = defaultApprovalPolicy.evaluate(approvalContext);

  // A "prompt" computed from a cached threshold may contradict a setting
  // the user just changed: the reader caches thresholds (5s conversation /
  // 30s global TTL) and no threshold write path invalidates this process's
  // caches. Re-read the threshold fresh before interrupting the user; when
  // the current value differs, re-evaluate so e.g. Full access never
  // prompts. A failed refresh returns null and keeps the prompt — fail
  // toward asking, never toward silent approval.
  if (approvalDecision.decision === "prompt") {
    const freshThreshold = await refreshAutoApproveThreshold(
      policyContext?.conversationId,
      policyContext?.executionContext,
      cellQuery,
      policyContext?.requesterContactId,
    );
    if (freshThreshold !== null && freshThreshold !== threshold) {
      approvalDecision = defaultApprovalPolicy.evaluate({
        ...approvalContext,
        autoApproveUpTo: freshThreshold,
      });
    }
  }

  // Enrich the reason with the classifier's explanation when available.
  // For risk-based fallback decisions (prompt/deny from High/Medium risk),
  // incorporate the classifier reason so the user sees *why* the command
  // was classified at that level (e.g. "High risk (Recursive force delete): requires approval").
  let enrichedReason = approvalDecision.reason;
  if (riskReason) {
    const riskLabelMatch = enrichedReason.match(
      /^(High|Medium|Low|high|medium|low) risk(.*)/i,
    );
    if (riskLabelMatch) {
      const capitalizedLabel =
        riskLabelMatch[1].charAt(0).toUpperCase() +
        riskLabelMatch[1].slice(1).toLowerCase();
      enrichedReason = `${capitalizedLabel} risk (${riskReason})${riskLabelMatch[2]}`;
    }
  }

  return {
    decision: approvalDecision.decision,
    reason: enrichedReason,
    hasSandboxAutoApprove:
      approvalDecision.reason ===
        "Workspace filesystem operation (sandbox auto-approve)" || undefined,
  };
}

export const SCOPE_AWARE_TOOLS = new Set([
  "bash",
  "host_bash",
  "file_read",
  "file_write",
  "file_edit",
  "host_file_read",
  "host_file_write",
  "host_file_edit",
  "host_file_transfer",
]);

export function generateScopeOptions(
  workingDir: string,
  toolName?: string,
): ScopeOption[] {
  if (toolName && !SCOPE_AWARE_TOOLS.has(toolName)) {
    return [];
  }

  const home = homedir();
  const options: ScopeOption[] = [];

  // Project directory
  const displayDir = workingDir.startsWith(home)
    ? "~" + workingDir.slice(home.length)
    : workingDir;
  options.push({ label: displayDir, scope: workingDir });

  // Parent directory
  const parentDir = dirname(workingDir);
  if (parentDir !== workingDir) {
    const displayParent = parentDir.startsWith(home)
      ? "~" + parentDir.slice(home.length)
      : parentDir;
    options.push({ label: `${displayParent}/*`, scope: parentDir });
  }

  // Everywhere
  options.push({ label: "everywhere", scope: "everywhere" });

  return options;
}
