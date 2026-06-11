import type { AssistantEntry } from "./assistant-config.js";
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

  console.log(
    `🔄 Restarting local assistant '${entry.assistantId}' on ${tag}...\n`,
  );

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
  const ready = await waitForReady(entry.runtimeUrl);
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
