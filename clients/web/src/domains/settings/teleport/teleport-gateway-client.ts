/**
 * Assistant-scoped gateway/runtime calls for teleport, ported from the macOS
 * `GatewayHTTPClient.withAssistant(...)` usage in `TeleportSection.swift`.
 *
 * Two transports, picked per assistant:
 *   - **local / docker** assistants are reached directly over their local
 *     gateway proxy (`/assistant/__gateway/<port>`), authenticated with a
 *     gateway token freshly minted from the assistant's guardian token. This
 *     mirrors the Swift `bootstrapActorToken` + `withAssistant` scoping and is
 *     isolated from the globally-active self-hosted connection so a teleport
 *     never disturbs the current session's token.
 *   - **managed (cloud)** assistants are reached through the platform's
 *     assistant proxy (`/v1/assistants/{id}/...`) via the generated API client,
 *     which already attaches the session + organization headers.
 */

import { client } from "@/generated/api/client.gen";
import { getLocalGatewayUrl } from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { fetchGuardianTokenHost } from "@/runtime/local-mode-host";

import { readArrayBufferWithProgress } from "./bundle-stream";
import { TeleportError } from "./teleport-types";

/**
 * Resolve the absolute local gateway base URL for a local or docker assistant
 * (`getLocalGatewayUrl` resolves the `/assistant/__gateway/<port>` proxy for
 * both); other hosting kinds never reach here because `resolveDestination`
 * doesn't offer teleport for them.
 */
function localGatewayBase(assistant: LockfileAssistant): string {
  const path = getLocalGatewayUrl(assistant);
  if (!path) {
    throw new TeleportError(
      "local_assistant_not_found",
      `Assistant ${assistant.assistantId} has no resolved local gateway.`,
    );
  }
  return `${window.location.origin}${path}`;
}

/**
 * Mint a gateway token for a specific local/docker assistant by exchanging its
 * guardian token at the gateway's `/auth/token` mint. Kept separate from the
 * shared `ensureGatewayToken` cache so teleporting to a target gateway doesn't
 * clobber the active session's token.
 */
async function mintLocalGatewayToken(
  assistant: LockfileAssistant,
  base: string,
): Promise<string> {
  const guardianToken = await fetchGuardianTokenHost(assistant.assistantId);
  const res = await fetch(`${base}/auth/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${guardianToken}` },
  });
  if (!res.ok) {
    throw new TeleportError(
      "not_signed_in",
      `Gateway token request failed (HTTP ${res.status}).`,
    );
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}

/**
 * Export a local/docker assistant's data as a `.vbundle` byte stream from its
 * gateway: `POST /v1/migrations/export`. Reports download progress (0..1).
 */
export async function exportLocalBundle(
  assistant: LockfileAssistant,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const base = localGatewayBase(assistant);
  const token = await mintLocalGatewayToken(assistant, base);
  const response = await fetch(`${base}/v1/migrations/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new TeleportError(
      "export_failed",
      `Export failed (HTTP ${response.status}).`,
    );
  }
  return readArrayBufferWithProgress(response, onProgress);
}

/**
 * Import `.vbundle` bytes into a local/docker assistant via its gateway:
 * `POST /v1/migrations/import` (octet-stream body). Throws on a non-2xx status
 * or a `{success:false}` body.
 */
export async function importLocalBundle(
  assistant: LockfileAssistant,
  bundle: ArrayBuffer,
): Promise<void> {
  const base = localGatewayBase(assistant);
  const token = await mintLocalGatewayToken(assistant, base);
  // Send the body as a Blob, not a raw ArrayBuffer. The local gateway proxy
  // runs over plain HTTP, and Chromium streams an ArrayBuffer body through a
  // fixed-capacity (~1-2 MB) renderer data pipe — a larger `.vbundle` stalls
  // forever when the local consumer drains it slowly, hanging on "Importing
  // data...". A Blob is passed by handle and read directly, with no pipe to
  // block on (the same fix `api-interceptors.ts` applies to local-mode bodies).
  const response = await fetch(`${base}/v1/migrations/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: new Blob([bundle], { type: "application/octet-stream" }),
  });
  if (!response.ok) {
    throw new TeleportError(
      "import_failed",
      `Import failed (HTTP ${response.status}).`,
    );
  }
  const json = (await safeJson(response)) as { success?: boolean; error?: string } | null;
  if (json && json.success === false) {
    throw new TeleportError(
      "import_failed",
      json.error ?? "Import reported failure",
    );
  }
}

/**
 * Ask a managed (cloud) assistant's runtime to export to a signed GCS URL:
 * `POST /v1/assistants/{id}/migrations/export-to-gcs/`. The export is async —
 * the runtime returns 202 + `job_id` and uploads in the background.
 */
export async function exportManagedToGcs(
  managedId: string,
  uploadUrl: string,
): Promise<string> {
  const { data, response } = await client.post<unknown, unknown, false>({
    url: "/v1/assistants/{assistant_id}/migrations/export-to-gcs/",
    path: { assistant_id: managedId },
    body: { upload_url: uploadUrl },
    throwOnError: false,
  });
  const status = response?.status ?? 0;
  if (!(response?.ok ?? false) && status !== 202) {
    throw new TeleportError("export_failed", `Export failed (HTTP ${status}).`);
  }
  const jobId = (data as { job_id?: string } | undefined)?.job_id;
  if (!jobId) {
    throw new TeleportError(
      "export_failed",
      "Export accepted but no job ID was returned.",
    );
  }
  return jobId;
}

/**
 * Poll a managed assistant's runtime-local export job until it completes:
 * `GET /v1/assistants/{id}/migrations/jobs/{jobId}`. Routes through the
 * assistant proxy so it reaches the runtime's in-memory job registry rather
 * than the platform job DB.
 */
export async function pollManagedExportJob(
  managedId: string,
  jobId: string,
): Promise<string> {
  const { data, response } = await client.get<unknown, unknown, false>({
    url: "/v1/assistants/{assistant_id}/migrations/jobs/{job_id}",
    path: { assistant_id: managedId, job_id: jobId },
    throwOnError: false,
  });
  const status = response?.status ?? 0;
  if (status >= 500) return "processing"; // transient — caller retries
  if (!(response?.ok ?? false)) {
    throw new TeleportError(
      "export_job_failed",
      `Job status check failed (HTTP ${status})`,
    );
  }
  const job = data as { status?: string; error?: string } | undefined;
  if (job?.status === "failed") {
    throw new TeleportError(
      "export_job_failed",
      job.error ?? "Export job failed",
    );
  }
  return job?.status ?? "processing";
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
