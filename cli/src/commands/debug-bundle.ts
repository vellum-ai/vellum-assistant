/**
 * `vellum debug-bundle [name]`
 *
 * Send Vellum staff a debug bundle of a self-hosted assistant: the
 * workspace, its logs, and the gateway's own database, with no credentials.
 * Staff open it on a throwaway debug clone. The platform only hands out the
 * upload URL while "Allow Staff Access" is on, and the bundle is deleted
 * after seven days.
 *
 * Steps: the daemon is checked for the debug profile, the platform mints
 * the upload URL, the daemon exports with the debug profile, and this
 * command waits for the job so the result is real.
 */
import {
  formatAssistantReference,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";
import { pollJobUntilDone } from "../lib/job-polling.js";
import {
  MigrationInProgressError,
  localRuntimeExportToGcs,
  localRuntimeIdentity,
  localRuntimePollJobStatus,
} from "../lib/local-runtime-client.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";
import {
  authHeaders,
  authHeadersForKnownOrganization,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client.js";
import { compareVersions } from "../lib/version-compat.js";

// Matches the daemon's own upload deadline (EXPORT_TO_GCS_PUT_TIMEOUT_MS in
// assistant/src/runtime/routes/migration-routes.ts), so a slow but healthy
// export is never reported as failed while it is still uploading.
const EXPORT_TIMEOUT_MS = 60 * 60 * 1000;
// The daemon release that added `profile: "debug"`. An older daemon strips
// the field and exports a normal teleport bundle, which carries the owner's
// credentials. That must never reach the staff bucket.
export const DEBUG_PROFILE_MIN_VERSION = "0.12.3";
// Renew a cached guardian token that is about to lapse instead of starting
// a long export on it.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

function printHelp(): void {
  console.log(`Usage: vellum debug-bundle [name]

Send Vellum staff a debug bundle of a self-hosted assistant so they can
inspect a copy of it. The bundle holds the assistant's workspace, its
logs, and the gateway's own database. It never holds credentials.

Arguments:
  name    Assistant ID or unique display name. Defaults to the active
          assistant (see 'vellum use'). Multi-word names need no quotes.

Requirements:
  - 'Allow Staff Access' is on for the assistant (Settings > Privacy).
  - You are logged in ('vellum login'), which also registers the
    assistant with the platform.
  - The assistant runs version ${DEBUG_PROFILE_MIN_VERSION} or newer.
  - The assistant is self-hosted. Vellum-hosted assistants need no bundle;
    staff clone them directly.

Side effects:
  - Uploads the bundle to Vellum's debug-bundle storage, where it is
    deleted after 7 days. Nothing on this machine changes.
  - Records a 'debug bundle exported' entry in your account's audit history.
  - Waits for the upload to finish (up to 60 minutes for a large workspace).

Examples:
  vellum debug-bundle
  vellum debug-bundle my-assistant
  vellum debug-bundle Support Bot
`);
}

export async function debugBundle(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const entry = resolveTargetAssistant(parseAssistantTargetArg(args));
  const reference = formatAssistantReference(entry);
  if (entry.cloud === "vellum") {
    console.error(
      `${reference} is hosted by Vellum, so staff can clone it directly. No bundle is needed.`,
    );
    process.exit(1);
  }

  const platformToken = readPlatformToken();
  if (!platformToken) {
    console.error("Not logged in. Run 'vellum login' first.");
    process.exit(1);
  }
  const platformAssistantId = entry.platformAssistantId?.trim();
  if (!platformAssistantId) {
    console.error(
      `${reference} is not registered with the platform yet. Run 'vellum login' and retry.`,
    );
    process.exit(1);
  }
  const platformUrl = entry.platformBaseUrl?.trim() || getPlatformUrl();
  const organizationId = entry.platformOrganizationId?.trim();

  // Step 1: a guardian token for the daemon, and a check that the daemon
  // knows the debug profile. This comes before the platform call so a
  // daemon that would export credentials is refused before any URL exists.
  let accessToken = await daemonAccessToken(entry, reference, false);
  const { version } = await localRuntimeIdentity(entry, accessToken);
  const comparison = compareVersions(version, DEBUG_PROFILE_MIN_VERSION);
  if (comparison === null || comparison < 0) {
    console.error(
      `${reference} runs version ${version || "unknown"}, which cannot build a debug bundle. Update it to ${DEBUG_PROFILE_MIN_VERSION} or newer ('vellum upgrade') and retry.`,
    );
    process.exit(1);
  }

  // Step 2: the platform mints the upload URL, and refuses unless the
  // owner's staff access grant is active.
  const headers = organizationId
    ? authHeadersForKnownOrganization(platformToken, organizationId)
    : await authHeaders(platformToken, platformUrl);
  const urlResponse = await loopbackSafeFetch(
    `${platformUrl}/v1/assistants/${encodeURIComponent(platformAssistantId)}/debug-bundle-upload-url/`,
    { method: "POST", headers },
  );
  if (urlResponse.status === 403) {
    console.error(
      "Staff access is off for this assistant. Turn on 'Allow Staff Access' in Settings > Privacy, then retry.",
    );
    process.exit(1);
  }
  if (!urlResponse.ok) {
    const detail = await urlResponse.text().catch(() => "");
    console.error(
      `Error: Could not get an upload URL (${urlResponse.status}): ${detail || urlResponse.statusText}`,
    );
    process.exit(1);
  }
  const { url: uploadUrl } = (await urlResponse.json()) as { url: string };

  // Step 3: the daemon builds and uploads the bundle.
  let jobId: string;
  try {
    ({ jobId } = await localRuntimeExportToGcs(entry, accessToken, {
      uploadUrl,
      description: "debug bundle for Vellum staff",
      profile: "debug",
    }));
  } catch (err) {
    if (err instanceof MigrationInProgressError) {
      console.error(
        `Error: Another export is already in progress (job ${err.existingJobId}). Wait for it to finish, then retry.`,
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`Export started (job ${jobId})...`);

  // Step 4: wait for the upload so the owner sees a real result. A large
  // export can outlive the guardian token, so a 401 mid-poll re-leases one.
  const terminal = await pollJobUntilDone({
    label: "debug bundle export",
    poll: () => localRuntimePollJobStatus(entry, accessToken, jobId),
    timeoutMs: EXPORT_TIMEOUT_MS,
    refreshOn401: async () => {
      accessToken = await daemonAccessToken(entry, reference, true);
    },
  });
  if (terminal.status === "failed") {
    console.error(`Error: Export failed: ${terminal.error}`);
    process.exit(1);
  }
  console.log(
    "Debug bundle sent to Vellum. Staff can open it for the next 7 days.",
  );
}

async function daemonAccessToken(
  entry: {
    assistantId: string;
    runtimeUrl: string;
    guardianBootstrapSecret?: string;
  },
  reference: string,
  forceRefresh: boolean,
): Promise<string> {
  if (!forceRefresh) {
    const cached = loadGuardianToken(entry.assistantId);
    if (
      cached &&
      new Date(cached.accessTokenExpiresAt).getTime() - Date.now() >
        TOKEN_EXPIRY_MARGIN_MS
    ) {
      return cached.accessToken;
    }
  }
  try {
    return (
      await leaseGuardianToken(
        entry.runtimeUrl,
        entry.assistantId,
        entry.guardianBootstrapSecret,
      )
    ).accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(`Error: Could not connect to ${reference}. Is it running?`);
      process.exit(1);
    }
    throw err;
  }
}
