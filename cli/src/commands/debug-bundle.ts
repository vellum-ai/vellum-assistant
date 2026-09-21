/**
 * `vellum debug-bundle [name]`
 *
 * Send Vellum staff a debug bundle of a self-hosted assistant: the
 * workspace, its logs, and the gateway's own database, with no credentials.
 * Staff open it on a throwaway debug clone. The platform only hands out the
 * upload URL while "Allow Staff Access" is on, and the bundle is deleted
 * after seven days.
 *
 * Steps: platform mints the upload URL, the daemon exports with the debug
 * profile, and this command waits for the job so the result is real.
 */
import { resolveAssistant } from "../lib/assistant-config.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";
import { pollJobUntilDone } from "../lib/job-polling.js";
import {
  MigrationInProgressError,
  localRuntimeExportToGcs,
  localRuntimePollJobStatus,
} from "../lib/local-runtime-client.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";
import {
  authHeaders,
  authHeadersForKnownOrganization,
  getPlatformUrl,
  readPlatformToken,
} from "../lib/platform-client.js";

const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

export async function debugBundle(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum debug-bundle [name]");
    console.log("");
    console.log(
      "Send Vellum staff a debug bundle of a self-hosted assistant: its",
    );
    console.log(
      "workspace, logs, and gateway database, with no credentials. Needs",
    );
    console.log(
      "'Allow Staff Access' turned on in Settings > Privacy. Kept for 7 days.",
    );
    return;
  }
  const nameArg = args.find((arg) => !arg.startsWith("-"));

  const entry = resolveAssistant(nameArg);
  if (!entry) {
    console.error(
      nameArg
        ? `No assistant found with name '${nameArg}'.`
        : "No active assistant. Run 'vellum use <name>' or pass a name.",
    );
    process.exit(1);
  }
  if (entry.cloud === "vellum") {
    console.error(
      "This assistant is hosted by Vellum, so staff can clone it directly. No bundle is needed.",
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
      "This assistant is not registered with the platform yet. Run 'vellum login' and retry.",
    );
    process.exit(1);
  }
  const platformUrl = entry.platformBaseUrl?.trim() || getPlatformUrl();
  const organizationId = entry.platformOrganizationId?.trim();

  // Step 1 — the platform mints the upload URL, and refuses unless the
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

  // Step 2 — the daemon builds and uploads the bundle.
  let accessToken: string;
  const tokenData = loadGuardianToken(entry.assistantId);
  if (tokenData && new Date(tokenData.accessTokenExpiresAt) > new Date()) {
    accessToken = tokenData.accessToken;
  } else {
    try {
      accessToken = (
        await leaseGuardianToken(
          entry.runtimeUrl,
          entry.assistantId,
          entry.guardianBootstrapSecret,
        )
      ).accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        console.error(
          `Error: Could not connect to assistant '${entry.name}'. Is it running?`,
        );
        process.exit(1);
      }
      throw err;
    }
  }

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

  // Step 3 — wait for the upload so the owner sees a real result.
  const terminal = await pollJobUntilDone({
    label: "debug bundle export",
    poll: () => localRuntimePollJobStatus(entry, accessToken, jobId),
    timeoutMs: EXPORT_TIMEOUT_MS,
  });
  if (terminal.status === "failed") {
    console.error(`Error: Export failed: ${terminal.error}`);
    process.exit(1);
  }
  console.log(
    "✅ Debug bundle sent to Vellum. Staff can open it for the next 7 days.",
  );
}
