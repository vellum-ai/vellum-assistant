import type { AssistantEntry } from "./assistant-config.js";
import { findAssistantByName, saveAssistantEntry } from "./assistant-config.js";
import { createBackup, pruneOldBackups } from "./backup-ops.js";
import { emitCliError } from "./cli-error.js";
import {
  getBlockingCallLeases,
  sleepLocalAssistant,
  wakeLocalAssistant,
} from "./local-lifecycle.js";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  buildStartingEvent,
  fetchCurrentVersion,
  waitForReady,
} from "./upgrade-lifecycle.js";
import { compareVersions } from "./version-compat.js";

function toTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * Resolve the version tag a local upgrade restarts onto. Local assistants run
 * the installed CLI's embedded runtime, so the only valid target is the CLI's
 * own version — any other explicit version is rejected with guidance.
 */
export function resolveLocalUpgradeTarget(
  requestedVersion: string | null,
  cliVersion: string,
): { ok: true; tag: string } | { ok: false; reason: string } {
  const cliTag = toTag(cliVersion);
  if (requestedVersion === null) {
    return { ok: true, tag: cliTag };
  }

  const requestedTag = toTag(requestedVersion);
  if (compareVersions(requestedTag, cliTag) === 0) {
    return { ok: true, tag: cliTag };
  }

  return {
    ok: false,
    reason:
      `Local assistants always run the installed CLI's embedded runtime (currently ${cliTag}), ` +
      `so they cannot be upgraded to ${requestedTag} directly. ` +
      `The only way to change versions is to change the CLI itself — run \`vellum upgrade --latest\` ` +
      `to update the CLI and restart the assistant on it.`,
  };
}

/**
 * Decide whether a local restart onto `tag` is a downgrade relative to the
 * currently running runtime. Mirrors the Docker upgrade guard: an unknown or
 * unparseable current version proceeds (with a warning when unknown); only a
 * strictly older target is rejected.
 */
export function checkLocalVersionDirection(
  tag: string,
  currentVersion: string | undefined,
): { ok: true; warning?: string } | { ok: false; reason: string } {
  if (!currentVersion) {
    return {
      ok: true,
      warning:
        "Could not determine current version from health endpoint — skipping version-direction check.",
    };
  }
  const cmp = compareVersions(tag, currentVersion);
  if (cmp !== null && cmp < 0) {
    return {
      ok: false,
      reason:
        `The local assistant is running ${currentVersion}, which is newer than this CLI's ` +
        `embedded runtime (${tag}). Restarting it now would downgrade the assistant onto an ` +
        `older runtime. Update the CLI instead — run \`vellum upgrade --latest\` — and retry.`,
    };
  }
  return { ok: true };
}

/**
 * Same-machine probe URL for a local assistant. `runtimeUrl` may be an
 * external/public address (e.g. a tunnel), while `localUrl` is persisted
 * specifically for loopback health checks.
 */
export function resolveLocalProbeUrl(
  entry: Pick<AssistantEntry, "localUrl" | "runtimeUrl">,
): string {
  return entry.localUrl ?? entry.runtimeUrl;
}

/**
 * "Upgrade" a local assistant: restart its daemon/gateway processes so they
 * pick up the installed CLI's embedded runtime. The actual version change
 * happens when the CLI itself is updated (see `vellum upgrade --latest`).
 */
export async function upgradeLocal(
  entry: AssistantEntry,
  requestedVersion: string | null,
  cliVersion: string,
): Promise<void> {
  const target = resolveLocalUpgradeTarget(requestedVersion, cliVersion);
  if (!target.ok) {
    console.error(`Error: ${target.reason}`);
    emitCliError("VERSION_DIRECTION", target.reason);
    process.exit(1);
  }
  const { tag } = target;

  // Check call leases BEFORE stopping anything or broadcasting.
  const blockingCallIds = getBlockingCallLeases(entry);
  if (blockingCallIds.length > 0) {
    const msg = `assistant is staying awake for active phone calls (${blockingCallIds.join(
      ", ",
    )}). Retry the upgrade after the call ends.`;
    console.error(`Error: ${msg}`);
    emitCliError("UNKNOWN", msg);
    process.exit(1);
  }

  const probeUrl = resolveLocalProbeUrl(entry);

  // Refuse downgrades BEFORE stopping anything — the running runtime may be
  // newer than this CLI (e.g. upgraded independently).
  const direction = checkLocalVersionDirection(
    tag,
    await fetchCurrentVersion(probeUrl),
  );
  if (!direction.ok) {
    console.error(`Error: ${direction.reason}`);
    emitCliError("VERSION_DIRECTION", direction.reason);
    process.exit(1);
  }
  if (direction.warning) {
    console.warn(`⚠️  ${direction.warning}\n`);
  }

  console.log(
    `🔄 Restarting local assistant '${entry.assistantId}' on ${tag}...\n`,
  );

  // Pre-upgrade backup before anything is stopped (best-effort, mirrors the
  // Docker upgrade path — the restarted runtime may run migrations).
  console.log("📦 Creating pre-upgrade backup...");
  const backupPath = await createBackup(probeUrl, entry.assistantId, {
    prefix: `${entry.assistantId}-pre-upgrade`,
    description: `Pre-upgrade snapshot before local restart on ${tag}`,
  });
  if (backupPath) {
    console.log(`   Backup saved: ${backupPath}\n`);
    pruneOldBackups(entry.assistantId, 3);
  } else {
    console.warn("⚠️  Pre-upgrade backup failed (continuing with upgrade)\n");
  }

  // Persist the backup path so restores target this attempt's snapshot,
  // never a stale backup from a prior cycle.
  {
    const current = findAssistantByName(entry.assistantId);
    if (current) {
      saveAssistantEntry({
        ...current,
        preUpgradeBackupPath: backupPath ?? undefined,
      });
    }
  }

  // Best-effort client notification (broadcastUpgradeEvent never throws).
  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildStartingEvent(tag, 30),
  );

  try {
    await sleepLocalAssistant(entry, { force: false });
  } catch (err) {
    // A call lease may have appeared between the check above and the sleep.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${detail}`);
    emitCliError("UNKNOWN", detail);
    process.exit(1);
  }

  await wakeLocalAssistant(entry, { watch: false, foreground: false });

  console.log("Waiting for assistant to become ready...");
  const ready = await waitForReady(probeUrl);
  if (!ready) {
    console.error("\n❌ Assistant failed to become ready within the timeout.");
    await broadcastUpgradeEvent(
      entry.runtimeUrl,
      entry.assistantId,
      buildCompleteEvent(tag, false),
    );
    emitCliError(
      "READINESS_TIMEOUT",
      `Local assistant '${entry.assistantId}' did not become ready after restart. Check 'vellum logs' for details.`,
    );
    process.exit(1);
  }

  await broadcastUpgradeEvent(
    entry.runtimeUrl,
    entry.assistantId,
    buildCompleteEvent(tag, true),
  );
  console.log(`\n✅ '${entry.assistantId}' restarted on ${tag}.`);
}
