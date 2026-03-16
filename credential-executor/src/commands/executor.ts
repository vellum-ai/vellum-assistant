/**
 * CES authenticated command executor.
 *
 * Orchestrates secure command execution through the following pipeline:
 *
 * 1. **Bundle resolution** — Resolve the bundle digest from the toolstore
 *    and verify the secure command manifest is published and approved.
 *
 * 2. **Profile validation** — Validate the command argv against the
 *    manifest's allowed profiles, checking for denied binaries, denied
 *    subcommands, and denied flags.
 *
 * 3. **Grant enforcement** — Verify that an active grant covers this
 *    bundle-digest/profile pair and credential handle.
 *
 * 4. **Workspace staging** — Stage declared workspace inputs into a
 *    CES-private scratch directory.
 *
 * 5. **Credential materialization** — Materialize the raw credential
 *    value from the credential store.
 *
 * 6. **Egress proxy startup** — Start a CES-owned egress proxy session
 *    (when egressMode is `proxy_required`) to enforce network target
 *    allowlists. This happens BEFORE the auth adapter runs so that
 *    credential_process helpers also execute under egress control.
 *
 * 7. **Auth adapter construction** — Build the credential environment
 *    through the declared auth adapter (env_var, temp_file, or
 *    credential_process). For credential_process, the helper runs
 *    with proxy env vars injected.
 *
 * 8. **Command execution** — Run the command with clean config dirs,
 *    materialized credential env vars, and proxy env vars. The command
 *    runs in the scratch directory, never in the assistant workspace.
 *
 * 9. **Output copyback** — After exit, validate and copy declared output
 *    files from the scratch directory back into the workspace.
 *
 * 10. **Cleanup** — Stop the egress proxy session, remove temp files, and
 *    clean up the scratch directory.
 *
 * The executor is fail-closed: bundle mismatches, missing grants,
 * adapter failures, egress failures, undeclared outputs, and scan
 * violations all result in command rejection before or after execution.
 */

import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  SessionStore,
  createSession,
  startSession,
  stopSession,
  getSessionEnv,
  type SessionStartHooks,
  type ProxyEnvVars,
} from "@vellumai/egress-proxy";

import { readPublishedManifest, getBundleContentPath, isBundlePublished } from "../toolstore/publish.js";
import { getCesToolStoreDir, type CesMode } from "../paths.js";
import type { SecureCommandManifest, CommandProfile } from "./profiles.js";
import { isDeniedBinary, EgressMode } from "./profiles.js";
import { validateCommand, extractShellBinary, containsShellMetacharacters, type CommandValidationResult } from "./validator.js";
import type { AuthAdapterConfig } from "./auth-adapters.js";
import { AuthAdapterType, validateAuthAdapterConfig } from "./auth-adapters.js";
import {
  stageInputs,
  copybackOutputs,
  cleanupScratchDir,
  type WorkspaceStageConfig,
  type WorkspaceInput,
  type WorkspaceOutput,
  type CopybackResult,
} from "./workspace.js";
import { hashProposal, type AuditRecordSummary, type CommandGrantProposal } from "@vellumai/ces-contracts";

import type { AuditStore } from "../audit/store.js";
import type { PersistentGrantStore } from "../grants/persistent-store.js";
import type { TemporaryGrantStore } from "../grants/temporary-store.js";
import type { SessionIdRef } from "../server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Request to execute an authenticated command through the CES pipeline.
 */
export interface ExecuteCommandRequest {
  /** SHA-256 hex digest of the approved bundle. */
  bundleDigest: string;
  /** Name of the command profile to use within the manifest. */
  profileName: string;
  /** CES credential handle identifying which credential to inject. */
  credentialHandle: string;
  /** Argv tokens (command arguments, not including the binary path). */
  argv: string[];
  /** Absolute path to the assistant-visible workspace directory. */
  workspaceDir: string;
  /** Files to stage as read-only inputs in the scratch directory. */
  inputs?: WorkspaceInput[];
  /** Files to copy back from the scratch directory after execution. */
  outputs?: WorkspaceOutput[];
  /** Human-readable purpose for audit logging. */
  purpose: string;
  /** Explicit grant ID to consume, if the caller holds one. */
  grantId?: string;
  /** Conversation ID for conversation-scoped temporary grants. */
  conversationId?: string;
}

/**
 * Result of a command execution attempt.
 */
export interface ExecuteCommandResult {
  /** Whether the command executed successfully. */
  success: boolean;
  /** Process exit code (undefined if the command was never launched). */
  exitCode?: number;
  /** Combined stdout output (truncated for safety). */
  stdout?: string;
  /** Combined stderr output (truncated for safety). */
  stderr?: string;
  /** Copyback results for declared outputs. */
  copybackResult?: CopybackResult;
  /** Error message if execution failed. */
  error?: string;
  /** Audit-relevant metadata. */
  auditId?: string;
  /**
   * When the failure reason is a missing grant, this field contains the
   * proposal metadata needed by the approval bridge. Present only when
   * the error is an approval-required grant failure.
   */
  approvalRequired?: {
    credentialHandle: string;
    bundleId: string;
    bundleDigest: string;
    profileName: string;
    command: string;
    purpose: string;
  };
}

/**
 * Credential materializer abstraction.
 *
 * The executor does not import materializer implementations directly.
 * Callers provide a materializer function that resolves a credential
 * handle into a raw secret value.
 */
export type MaterializeCredentialFn = (
  credentialHandle: string,
) => Promise<MaterializeCredentialResult>;

export type MaterializeCredentialResult =
  | { ok: true; value: string; handleType: string }
  | { ok: false; error: string };

/**
 * Dependencies injected into the command executor.
 */
export interface CommandExecutorDeps {
  /** Persistent grant store for checking bundle/profile approvals. */
  persistentStore: PersistentGrantStore;
  /** Temporary grant store for session-scoped approvals. */
  temporaryStore: TemporaryGrantStore;
  /** Credential materializer function. */
  materializeCredential: MaterializeCredentialFn;
  /** Audit store for persisting token-free audit records. */
  auditStore?: AuditStore;
  /** Mutable reference to the session ID for audit records. Updated to the handshake session ID once the RPC handshake completes. */
  sessionId?: SessionIdRef;
  /** CES operating mode (for toolstore path resolution). */
  cesMode?: CesMode;
  /** Egress proxy session start hooks (for creating the proxy server). */
  egressHooks?: SessionStartHooks;
  /** Egress proxy session store (shared or isolated). */
  egressSessionStore?: SessionStore;
  /** Maximum stdout/stderr capture size in bytes. */
  maxOutputBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum stdout/stderr capture (256 KB). */
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Credential process helper timeout. */
const CREDENTIAL_PROCESS_TIMEOUT_MS = 10_000;

/**
 * Banned binary names — checked at execution time as a defense-in-depth
 * supplement to the manifest validator's static check.
 */

// ---------------------------------------------------------------------------
// Executor implementation
// ---------------------------------------------------------------------------

/**
 * Execute an authenticated command through the full CES pipeline.
 *
 * This is the top-level orchestrator. Each step is fail-closed: if any
 * phase returns an error, the command is rejected and cleanup runs.
 */
export async function executeAuthenticatedCommand(
  request: ExecuteCommandRequest,
  deps: CommandExecutorDeps,
): Promise<ExecuteCommandResult> {
  const auditId = randomUUID();

  // -- 1. Resolve and validate the bundle -----------------------------------
  const bundleResult = resolveBundle(request.bundleDigest, deps.cesMode);
  if (!bundleResult.ok) {
    return {
      success: false,
      error: bundleResult.error,
      auditId,
    };
  }

  const { manifest, toolstoreDir } = bundleResult;

  // -- 2. Validate the command profile and argv -----------------------------
  const profileResult = validateProfile(
    manifest,
    request.profileName,
    request.argv,
  );
  if (!profileResult.ok) {
    return {
      success: false,
      error: profileResult.error,
      auditId,
    };
  }

  // -- 3. Check grant enforcement -------------------------------------------
  const grantResult = checkGrant(
    request,
    manifest,
    request.profileName,
    deps.persistentStore,
    deps.temporaryStore,
  );
  if (!grantResult.ok) {
    return {
      success: false,
      error: grantResult.error,
      auditId,
      approvalRequired: {
        credentialHandle: request.credentialHandle,
        bundleId: manifest.bundleId,
        bundleDigest: request.bundleDigest,
        profileName: request.profileName,
        command: `${request.bundleDigest}/${request.profileName} ${request.argv.join(" ")}`.trim(),
        purpose: request.purpose,
      },
    };
  }

  // -- 4. Stage workspace inputs --------------------------------------------
  const stageConfig: WorkspaceStageConfig = {
    workspaceDir: request.workspaceDir,
    inputs: request.inputs ?? [],
    outputs: request.outputs ?? [],
    secrets: new Set<string>(), // Populated after materialization
  };

  let scratchDir: string;
  try {
    const staged = stageInputs(stageConfig, deps.cesMode);
    scratchDir = staged.scratchDir;
  } catch (err) {
    return {
      success: false,
      error: `Input staging failed: ${err instanceof Error ? err.message : String(err)}`,
      auditId,
    };
  }

  // -- 5. Materialize the credential ----------------------------------------
  const matResult = await deps.materializeCredential(request.credentialHandle);
  if (!matResult.ok) {
    cleanupScratchDir(scratchDir);
    return {
      success: false,
      error: `Credential materialization failed: ${matResult.error}`,
      auditId,
    };
  }

  // Update the stage config with the materialized secret for output scanning
  const secretSet = new Set<string>([matResult.value]);
  const stageConfigWithSecrets: WorkspaceStageConfig = {
    ...stageConfig,
    secrets: secretSet,
  };

  // -- 6. Start egress proxy (if proxy_required) ----------------------------
  // The egress proxy must be started BEFORE the auth adapter runs, so that
  // credential_process helpers execute under egress control (not in an
  // uncontrolled network state).
  let proxyEnv: ProxyEnvVars | undefined;
  let proxySessionId: string | undefined;
  const sessionStore = deps.egressSessionStore ?? new SessionStore();

  if (manifest.egressMode === EgressMode.ProxyRequired) {
    if (!deps.egressHooks) {
      cleanupScratchDir(scratchDir);
      return {
        success: false,
        error: "Egress mode is proxy_required but no egress hooks were provided. " +
          "Cannot enforce network policy without an egress proxy.",
        auditId,
      };
    }

    try {
      const conversationId = request.conversationId ?? `ces-cmd-${auditId}`;
      // Carry the profile's allowedNetworkTargets into the session config
      // so the egress proxy can enforce the allowlist.
      const profile = manifest.commandProfiles[request.profileName];
      const allowedTargets = profile?.allowedNetworkTargets?.map((t) => ({
        host: t.hostPattern,
        ...(t.ports ? { ports: t.ports } : {}),
        ...(t.protocols ? { protocols: t.protocols } : {}),
      }));
      const session = createSession(
        sessionStore,
        conversationId,
        [request.credentialHandle],
        { allowedTargets },
      );
      const started = await startSession(
        sessionStore,
        session.id,
        deps.egressHooks,
      );
      proxySessionId = started.id;
      proxyEnv = getSessionEnv(sessionStore, started.id);
    } catch (err) {
      cleanupScratchDir(scratchDir);
      return {
        success: false,
        error: `Egress proxy startup failed: ${err instanceof Error ? err.message : String(err)}`,
        auditId,
      };
    }
  }

  // For no_network mode, block all outbound by pointing proxy vars at a
  // non-existent address. This prevents subprocesses from making direct
  // connections even without a running egress proxy.
  let noNetworkEnv: Record<string, string> | undefined;
  if (manifest.egressMode === EgressMode.NoNetwork) {
    const blockedProxy = "http://127.0.0.1:0";
    noNetworkEnv = {
      HTTP_PROXY: blockedProxy,
      HTTPS_PROXY: blockedProxy,
      http_proxy: blockedProxy,
      https_proxy: blockedProxy,
      NO_PROXY: "",
      no_proxy: "",
    };
  }

  // -- 7. Build auth adapter environment ------------------------------------
  // Pass proxy/no-network env vars so credential_process helpers also run
  // under egress control.
  let adapterEnv: Record<string, string>;
  let tempFilePath: string | undefined;
  try {
    const adapterResult = await buildAuthAdapterEnv(
      manifest.authAdapter,
      matResult.value,
      proxyEnv,
      noNetworkEnv,
    );
    adapterEnv = adapterResult.env;
    tempFilePath = adapterResult.tempFilePath;
  } catch (err) {
    // Stop the proxy session before returning — it may already be running
    if (proxySessionId) {
      try {
        await stopSession(proxySessionId, sessionStore);
      } catch {
        // Best-effort proxy cleanup
      }
    }
    cleanupScratchDir(scratchDir);
    return {
      success: false,
      error: `Auth adapter materialization failed: ${err instanceof Error ? err.message : String(err)}`,
      auditId,
    };
  }

  // -- 8. Build the execution environment -----------------------------------
  const bundleDir = dirname(getBundleContentPath(toolstoreDir, request.bundleDigest));
  const entrypointPath = resolve(bundleDir, manifest.entrypoint);

  // Containment check: entrypoint must resolve inside the bundle directory
  // (lexical check for path traversal via ../)
  if (!entrypointPath.startsWith(bundleDir + "/") && entrypointPath !== bundleDir) {
    // Stop the proxy session before returning — it may already be running
    if (proxySessionId) {
      try {
        await stopSession(proxySessionId, sessionStore);
      } catch {
        // Best-effort proxy cleanup
      }
    }
    cleanupAll(scratchDir, tempFilePath);
    return {
      success: false,
      error: `Entrypoint "${manifest.entrypoint}" resolves outside the bundle directory. ` +
        `Path traversal is not allowed.`,
      auditId,
    };
  }

  // Symlink escape check: follow symlinks and verify the real path is
  // still inside the bundle directory. A symlink entrypoint like
  // `bin/tool -> /usr/bin/curl` passes the lexical check above but
  // executes outside the bundle boundary.
  let realEntrypointPath: string;
  try {
    realEntrypointPath = realpathSync(entrypointPath);
  } catch {
    // realpathSync fails if the file doesn't exist or is a broken symlink
    if (proxySessionId) {
      try {
        await stopSession(proxySessionId, sessionStore);
      } catch {
        // Best-effort proxy cleanup
      }
    }
    cleanupAll(scratchDir, tempFilePath);
    return {
      success: false,
      error: `Entrypoint "${manifest.entrypoint}" could not be resolved (broken symlink or missing file).`,
      auditId,
    };
  }
  const realBundleDir = realpathSync(bundleDir);
  if (!realEntrypointPath.startsWith(realBundleDir + "/") && realEntrypointPath !== realBundleDir) {
    if (proxySessionId) {
      try {
        await stopSession(proxySessionId, sessionStore);
      } catch {
        // Best-effort proxy cleanup
      }
    }
    cleanupAll(scratchDir, tempFilePath);
    return {
      success: false,
      error: `Entrypoint "${manifest.entrypoint}" is a symlink that resolves to "${realEntrypointPath}", ` +
        `which is outside the bundle directory. Symlink escape is not allowed.`,
      auditId,
    };
  }

  // Generate HOME path before buildCommandEnv so we have a known-safe value
  // for cleanup. buildCommandEnv sets HOME after spreading adapterEnv to
  // prevent auth adapters from overriding the isolated home directory.
  const generatedHomeDir = join(tmpdir(), `ces-home-${randomUUID()}`);

  // Create the HOME directory and enforce cleanConfigDirs before building env
  try {
    mkdirSync(generatedHomeDir, { recursive: true });
    enforceCleanConfigDirs(manifest, generatedHomeDir);
  } catch (err) {
    if (proxySessionId) {
      try {
        await stopSession(proxySessionId, sessionStore);
      } catch {
        // Best-effort proxy cleanup
      }
    }
    cleanupAll(scratchDir, tempFilePath, generatedHomeDir);
    return {
      success: false,
      error: `Clean config dirs setup failed: ${err instanceof Error ? err.message : String(err)}`,
      auditId,
    };
  }

  const commandEnv = buildCommandEnv(
    adapterEnv,
    proxyEnv,
    noNetworkEnv,
    generatedHomeDir,
  );

  // -- 9. Execute the command -----------------------------------------------
  const maxOutput = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let execResult: ExecuteCommandResult;

  try {
    execResult = await runCommand(
      entrypointPath,
      request.argv,
      scratchDir,
      commandEnv,
      maxOutput,
      auditId,
    );
  } catch (err) {
    execResult = {
      success: false,
      error: `Command execution failed: ${err instanceof Error ? err.message : String(err)}`,
      auditId,
    };
  }

  // -- 10. Output copyback --------------------------------------------------
  if (
    request.outputs &&
    request.outputs.length > 0 &&
    execResult.exitCode !== undefined
  ) {
    try {
      const copybackResult = copybackOutputs(
        stageConfigWithSecrets,
        scratchDir,
      );
      execResult.copybackResult = copybackResult;

      if (!copybackResult.allSucceeded) {
        const failures = copybackResult.outputs
          .filter((o) => !o.success)
          .map((o) => `${o.scratchPath}: ${o.reason}`)
          .join("; ");
        execResult.error = execResult.error
          ? `${execResult.error}; Output copyback failures: ${failures}`
          : `Output copyback failures: ${failures}`;
      }
    } catch (err) {
      execResult.error = execResult.error
        ? `${execResult.error}; Output copyback error: ${err instanceof Error ? err.message : String(err)}`
        : `Output copyback error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -- 11. Cleanup ----------------------------------------------------------
  if (proxySessionId) {
    try {
      await stopSession(proxySessionId, sessionStore);
    } catch {
      // Best-effort proxy cleanup
    }
  }

  cleanupAll(scratchDir, tempFilePath, generatedHomeDir);

  // -- 12. Persist audit record -----------------------------------------------
  if (deps.auditStore) {
    const auditRecord: AuditRecordSummary = {
      auditId,
      grantId: grantResult.grantId ?? "unknown",
      credentialHandle: request.credentialHandle,
      toolName: "command",
      target: `${request.bundleDigest}/${request.profileName}`,
      sessionId: deps.sessionId?.current ?? "unknown",
      success: execResult.success,
      ...(execResult.error ? { errorMessage: execResult.error } : {}),
      timestamp: new Date().toISOString(),
    };
    try { deps.auditStore.append(auditRecord); } catch { /* audit persistence must not block execution */ }
  }

  return execResult;
}

// ---------------------------------------------------------------------------
// Internal: Bundle resolution
// ---------------------------------------------------------------------------

type BundleResolutionResult =
  | { ok: true; manifest: SecureCommandManifest; toolstoreDir: string }
  | { ok: false; error: string };

function resolveBundle(
  bundleDigest: string,
  cesMode?: CesMode,
): BundleResolutionResult {
  if (!isBundlePublished(bundleDigest, cesMode)) {
    return {
      ok: false,
      error: `Bundle with digest "${bundleDigest}" is not published in the CES toolstore. ` +
        `Only approved bundles can be executed.`,
    };
  }

  const toolstoreManifest = readPublishedManifest(bundleDigest, cesMode);
  if (!toolstoreManifest) {
    return {
      ok: false,
      error: `Bundle manifest for digest "${bundleDigest}" could not be read from the toolstore.`,
    };
  }

  const manifest = toolstoreManifest.secureCommandManifest;

  // Defense-in-depth: re-check denied binary at execution time
  if (isDeniedBinary(manifest.entrypoint)) {
    return {
      ok: false,
      error: `Entrypoint "${manifest.entrypoint}" is a structurally denied binary. ` +
        `Generic HTTP clients, interpreters, and shell trampolines cannot be executed.`,
    };
  }

  if (isDeniedBinary(manifest.bundleId)) {
    return {
      ok: false,
      error: `Bundle ID "${manifest.bundleId}" matches a structurally denied binary name.`,
    };
  }

  const toolstoreDir = getCesToolStoreDir(cesMode);

  return {
    ok: true,
    manifest,
    toolstoreDir,
  };
}

// ---------------------------------------------------------------------------
// Internal: Profile validation
// ---------------------------------------------------------------------------

interface ProfileValidationResult {
  ok: boolean;
  profile?: CommandProfile;
  matchedPattern?: string;
  error?: string;
}

function validateProfile(
  manifest: SecureCommandManifest,
  profileName: string,
  argv: string[],
): ProfileValidationResult {
  const profile = manifest.commandProfiles[profileName];
  if (!profile) {
    const available = Object.keys(manifest.commandProfiles).join(", ");
    return {
      ok: false,
      error: `Profile "${profileName}" not found in manifest for bundle "${manifest.bundleId}". ` +
        `Available profiles: ${available}`,
    };
  }

  // Validate the argv against the full manifest (checks denied subcommands/flags
  // across all profiles, then matches against allowed patterns)
  const cmdResult: CommandValidationResult = validateCommand(manifest, argv);
  if (!cmdResult.allowed) {
    return {
      ok: false,
      error: `Command validation failed: ${cmdResult.reason}`,
    };
  }

  // Ensure the matched profile is the requested one
  if (cmdResult.matchedProfile !== profileName) {
    return {
      ok: false,
      error: `Command argv matched profile "${cmdResult.matchedProfile}" but the requested ` +
        `profile is "${profileName}". The command does not match any pattern in the requested profile.`,
    };
  }

  return {
    ok: true,
    profile,
    matchedPattern: cmdResult.matchedPattern,
  };
}

// ---------------------------------------------------------------------------
// Internal: Grant enforcement
// ---------------------------------------------------------------------------

interface GrantCheckResult {
  ok: boolean;
  grantId?: string;
  error?: string;
}

function checkGrant(
  request: ExecuteCommandRequest,
  manifest: SecureCommandManifest,
  profileName: string,
  persistentStore: PersistentGrantStore,
  temporaryStore: TemporaryGrantStore,
): GrantCheckResult {
  // Build the full legacy command string for exact matching against legacy grants.
  const legacyCommand = `${request.bundleDigest}/${profileName} ${request.argv.join(" ")}`.trim();

  // If an explicit grantId is provided, check it directly — but verify
  // that the grant's scope matches the current request. Without this
  // check, an agent with a valid grant for one command/credential could
  // reuse the grantId for a different command/credential (authorization
  // bypass).
  if (request.grantId) {
    const grant = persistentStore.getById(request.grantId);
    if (
      grant &&
      grant.tool === "command" &&
      grant.scope === request.credentialHandle &&
      grantMatchesCommand(grant.pattern, request.credentialHandle, request.bundleDigest, profileName, legacyCommand)
    ) {
      return { ok: true, grantId: grant.id };
    }
    // Explicit grant not found or does not match this request — fall through to pattern matching
  }

  // Check persistent grants for a matching command grant
  const allGrants = persistentStore.getAll();
  for (const grant of allGrants) {
    if (
      grant.tool === "command" &&
      grant.scope === request.credentialHandle &&
      grantMatchesCommand(grant.pattern, request.credentialHandle, request.bundleDigest, profileName, legacyCommand)
    ) {
      return { ok: true, grantId: grant.id };
    }
  }

  // Check temporary grants — build the same proposal shape that the
  // approval bridge produces, then hash with the canonical algorithm
  // from `@vellumai/ces-contracts` so the hashes align.
  const tempProposal: CommandGrantProposal = {
    type: "command",
    credentialHandle: request.credentialHandle,
    command: `${request.bundleDigest}/${profileName} ${request.argv.join(" ")}`.trim(),
    purpose: request.purpose,
    allowedCommandPatterns: [`${request.credentialHandle}:${request.bundleDigest}:${profileName}`],
  };
  const proposalHash = hashProposal(tempProposal);
  const tempKind = temporaryStore.checkAny(
    proposalHash,
    request.conversationId,
  );
  if (tempKind) {
    return { ok: true, grantId: `temp:${tempKind}:${proposalHash}` };
  }

  return {
    ok: false,
    error: `No active grant found for bundle="${manifest.bundleId}", ` +
      `profile="${profileName}", credential="${request.credentialHandle}". ` +
      `Approval is required before command execution.`,
  };
}

/**
 * Check if a persistent grant pattern matches a command invocation.
 *
 * Grant patterns for commands can be stored in two formats:
 * 1. Canonical: `<credentialHandle>:<bundleDigest>:<profileName>` (from allowedCommandPatterns)
 * 2. Legacy:    `<bundleDigest>/<profileName> <argv...>` (from proposal.command fallback)
 *
 * The legacy format exists because older grants were persisted using
 * `proposal.command` before `allowedCommandPatterns` was introduced.
 * Credential scope is already verified by the caller (`grant.scope === credentialHandle`),
 * so for legacy patterns we match the full command string (including argv) to prevent
 * a grant for one argv from authorizing a different argv on the same profile.
 */
function grantMatchesCommand(
  pattern: string,
  credentialHandle: string,
  bundleDigest: string,
  profileName: string,
  legacyCommand: string,
): boolean {
  // Canonical format: <credentialHandle>:<bundleDigest>:<profileName>
  if (pattern === `${credentialHandle}:${bundleDigest}:${profileName}`) {
    return true;
  }

  // Legacy format: <bundleDigest>/<profileName> <argv...>
  // Match the full legacy command string exactly to prevent approval scope widening.
  if (pattern === legacyCommand) {
    return true;
  }

  return false;
}


// ---------------------------------------------------------------------------
// Internal: Auth adapter environment construction
// ---------------------------------------------------------------------------

interface AuthAdapterEnvResult {
  /** Environment variables to inject into the command. */
  env: Record<string, string>;
  /** Path to a temp file that must be cleaned up (for temp_file adapter). */
  tempFilePath?: string;
}

async function buildAuthAdapterEnv(
  adapter: AuthAdapterConfig,
  credentialValue: string,
  proxyEnv?: ProxyEnvVars,
  noNetworkEnv?: Record<string, string>,
): Promise<AuthAdapterEnvResult> {
  // Validate adapter config
  const errors = validateAuthAdapterConfig(adapter);
  if (errors.length > 0) {
    throw new Error(
      `Invalid auth adapter config: ${errors.join("; ")}`,
    );
  }

  switch (adapter.type) {
    case AuthAdapterType.EnvVar: {
      const value = adapter.valuePrefix
        ? `${adapter.valuePrefix}${credentialValue}`
        : credentialValue;
      return {
        env: { [adapter.envVarName]: value },
      };
    }

    case AuthAdapterType.TempFile: {
      // Write credential to a temp file and set the env var to the path
      const tempDir = join(tmpdir(), `ces-auth-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
      const ext = adapter.fileExtension ?? "";
      const tempPath = join(tempDir, `credential${ext}`);
      const mode = adapter.fileMode ?? 0o600;
      writeFileSync(tempPath, credentialValue, { mode });
      return {
        env: { [adapter.envVarName]: tempPath },
        tempFilePath: tempPath,
      };
    }

    case AuthAdapterType.CredentialProcess: {
      // Run the helper command and capture its stdout.
      // Proxy env vars are forwarded so the helper runs under the same
      // egress control as the main command.
      const timeoutMs = adapter.timeoutMs ?? CREDENTIAL_PROCESS_TIMEOUT_MS;
      const helperResult = await runCredentialProcess(
        adapter.helperCommand,
        credentialValue,
        timeoutMs,
        proxyEnv,
        noNetworkEnv,
      );
      if (!helperResult.ok) {
        throw new Error(
          `Credential process helper failed: ${helperResult.error}`,
        );
      }
      return {
        env: { [adapter.envVarName]: helperResult.stdout },
      };
    }

    default:
      throw new Error(`Unknown auth adapter type: ${(adapter as AuthAdapterConfig).type}`);
  }
}

/**
 * Run a credential_process helper command inside CES.
 *
 * The helper receives the raw credential value on stdin and writes
 * the transformed credential to stdout. It is never exposed to the
 * subprocess directly.
 */
async function runCredentialProcess(
  helperCommand: string,
  credentialValue: string,
  timeoutMs: number,
  proxyEnv?: ProxyEnvVars,
  noNetworkEnv?: Record<string, string>,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  // Defense-in-depth: re-check denied binary and metacharacters at execution
  // time, mirroring the validator's static checks. If a manifest was tampered
  // with after validation, this blocks execution before spawning the shell.
  if (containsShellMetacharacters(helperCommand)) {
    return {
      ok: false,
      error: `Credential process helperCommand contains shell metacharacters. ` +
        `Command chaining operators are not allowed.`,
    };
  }

  const helperBinary = extractShellBinary(helperCommand);
  if (isDeniedBinary(helperBinary)) {
    return {
      ok: false,
      error: `Credential process helperCommand starts with denied binary "${helperBinary}". ` +
        `Generic HTTP clients, interpreters, and shell trampolines cannot be used as credential helpers.`,
    };
  }

  try {
    // Build a minimal environment for the helper. No host env is inherited,
    // but egress proxy or no-network env vars are injected so the helper
    // runs under the same network controls as the main command.
    const helperEnv: Record<string, string> = {};

    if (proxyEnv) {
      helperEnv["HTTP_PROXY"] = proxyEnv.HTTP_PROXY;
      helperEnv["HTTPS_PROXY"] = proxyEnv.HTTPS_PROXY;
      helperEnv["NO_PROXY"] = proxyEnv.NO_PROXY;
      helperEnv["http_proxy"] = proxyEnv.HTTP_PROXY;
      helperEnv["https_proxy"] = proxyEnv.HTTPS_PROXY;
      helperEnv["no_proxy"] = proxyEnv.NO_PROXY;
      if (proxyEnv.NODE_EXTRA_CA_CERTS) {
        helperEnv["NODE_EXTRA_CA_CERTS"] = proxyEnv.NODE_EXTRA_CA_CERTS;
      }
      if (proxyEnv.SSL_CERT_FILE) {
        helperEnv["SSL_CERT_FILE"] = proxyEnv.SSL_CERT_FILE;
      }
    }

    if (noNetworkEnv) {
      Object.assign(helperEnv, noNetworkEnv);
    }

    const proc = Bun.spawn(["sh", "-c", helperCommand], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: helperEnv,
    });

    // Write the credential value to stdin for the helper to consume
    proc.stdin.write(credentialValue);
    proc.stdin.end();

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    // Consume stdout/stderr concurrently with waiting for exit to avoid
    // pipe buffer deadlocks when the helper produces large output.
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener("abort", () => {
          proc.kill();
          reject(new Error(`Credential process timed out after ${timeoutMs}ms`));
        });
      }),
    ]);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: `Helper exited with code ${exitCode}: ${stderr.trim()}`,
      };
    }

    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal: Command environment construction
// ---------------------------------------------------------------------------

/**
 * Build the clean execution environment for the command.
 *
 * The environment contains:
 * - Auth adapter env vars (credential injection)
 * - Proxy env vars (when egress proxy is active)
 * - HOME set to a temp directory (isolates config reads)
 * - PATH preserved from the CES process
 *
 * The environment explicitly does NOT inherit the CES process env.
 * Clean config dirs are handled by setting HOME to a temp directory.
 */
function buildCommandEnv(
  adapterEnv: Record<string, string>,
  proxyEnv?: ProxyEnvVars,
  noNetworkEnv?: Record<string, string>,
  homeDir?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    // Inject auth adapter env vars first so they cannot override protected keys
    ...adapterEnv,
    // PATH, LANG, and HOME are set after adapterEnv spread to prevent auth
    // adapters from overriding baseline environment invariants.
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    HOME: homeDir ?? join(tmpdir(), `ces-home-${randomUUID()}`),
  };

  // Inject proxy env vars if the egress proxy is active
  if (proxyEnv) {
    env["HTTP_PROXY"] = proxyEnv.HTTP_PROXY;
    env["HTTPS_PROXY"] = proxyEnv.HTTPS_PROXY;
    env["NO_PROXY"] = proxyEnv.NO_PROXY;
    env["http_proxy"] = proxyEnv.HTTP_PROXY;
    env["https_proxy"] = proxyEnv.HTTPS_PROXY;
    env["no_proxy"] = proxyEnv.NO_PROXY;
    if (proxyEnv.NODE_EXTRA_CA_CERTS) {
      env["NODE_EXTRA_CA_CERTS"] = proxyEnv.NODE_EXTRA_CA_CERTS;
    }
    if (proxyEnv.SSL_CERT_FILE) {
      env["SSL_CERT_FILE"] = proxyEnv.SSL_CERT_FILE;
    }
  }

  // For no_network mode, inject proxy vars pointing at a dead address to
  // block direct outbound connections from the subprocess.
  if (noNetworkEnv) {
    Object.assign(env, noNetworkEnv);
  }

  return env;
}

// ---------------------------------------------------------------------------
// Internal: Clean config dirs enforcement
// ---------------------------------------------------------------------------

/**
 * Enforce the manifest's `cleanConfigDirs` contract by creating empty
 * directories under the temp HOME directory.
 *
 * For each entry in `cleanConfigDirs`:
 * - `~/`-prefixed paths are resolved relative to the temp HOME dir and
 *   created as empty directories. This ensures the command finds an empty
 *   config directory instead of reading host config that might contain secrets.
 * - Absolute paths (not `~/`-prefixed) are skipped for v1 — they would
 *   require filesystem-level isolation (bind mounts, overlayfs).
 */
function enforceCleanConfigDirs(
  manifest: SecureCommandManifest,
  homeDir: string,
): void {
  const dirs = manifest.cleanConfigDirs;
  if (!dirs) return;

  for (const dirPath of Object.keys(dirs)) {
    // Only handle ~/‑prefixed paths for v1
    if (dirPath.startsWith("~/")) {
      const relativePath = dirPath.slice(2); // strip "~/"
      const resolvedPath = resolve(homeDir, relativePath);
      // Containment check: resolved path must stay inside homeDir
      if (!resolvedPath.startsWith(homeDir + "/") && resolvedPath !== homeDir) {
        continue; // Skip paths that escape the home directory
      }
      mkdirSync(resolvedPath, { recursive: true });
    } else if (dirPath === "~") {
      // "~" alone is just the home dir itself, already created
      continue;
    }
    // Absolute paths are skipped — would require filesystem-level isolation
  }
}

// ---------------------------------------------------------------------------
// Internal: Command execution
// ---------------------------------------------------------------------------

async function runCommand(
  entrypointPath: string,
  argv: string[],
  scratchDir: string,
  env: Record<string, string>,
  maxOutputBytes: number,
  auditId: string,
): Promise<ExecuteCommandResult> {
  // Ensure the HOME directory exists (for clean config dirs isolation)
  if (env["HOME"]) {
    mkdirSync(env["HOME"], { recursive: true });
  }

  const proc = Bun.spawn([entrypointPath, ...argv], {
    cwd: scratchDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Consume stdout/stderr concurrently with waiting for exit to avoid
  // pipe buffer deadlocks when the command produces output exceeding the
  // OS pipe buffer size (~64KB).
  const [exitCode, stdoutRaw, stderrRaw] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const stdout = stdoutRaw.length > maxOutputBytes
    ? stdoutRaw.slice(0, maxOutputBytes) + "\n[output truncated]"
    : stdoutRaw;

  const stderr = stderrRaw.length > maxOutputBytes
    ? stderrRaw.slice(0, maxOutputBytes) + "\n[output truncated]"
    : stderrRaw;

  return {
    success: exitCode === 0,
    exitCode,
    stdout,
    stderr,
    auditId,
    ...(exitCode !== 0 ? { error: `Command exited with code ${exitCode}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal: Cleanup helpers
// ---------------------------------------------------------------------------

function cleanupAll(scratchDir: string, tempFilePath?: string, homeDir?: string): void {
  // Clean up temp auth file
  if (tempFilePath) {
    try {
      unlinkSync(tempFilePath);
      // Also remove the parent temp directory
      rmSync(dirname(tempFilePath), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  // Clean up per-execution HOME temp directory
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  // Clean up scratch directory
  cleanupScratchDir(scratchDir);
}
