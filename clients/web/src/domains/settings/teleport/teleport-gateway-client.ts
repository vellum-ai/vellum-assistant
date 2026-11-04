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

import { z } from "zod";

import { client } from "@/generated/api/client.gen";
import { t } from "@/i18n";
import { getLocalGatewayUrl } from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { fetchGuardianTokenHost } from "@/runtime/local-mode-host";

import { readArrayBufferWithProgress } from "./bundle-stream";
import { TeleportError, type TeleportErrorCode } from "./teleport-types";

const LocalRuntimeErrorSchema = z.object({
  error: z.object({ message: z.string().min(1) }),
});

const LocalImportStartedSchema = z.object({ job_id: z.string().min(1) });

const LocalMigrationJobSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("processing") }),
  z.object({ status: z.literal("complete") }),
  z.object({
    status: z.literal("failed"),
    error: z.string().optional().catch(undefined),
  }),
]);

/** A migration job as the local runtime's `GET /v1/migrations/jobs/{id}` reports it. */
export type LocalMigrationJob = z.infer<typeof LocalMigrationJobSchema>;

/** The local runtime's answer to a request to start an import from a URL. */
export type LocalImportStart =
  | { ok: true; jobId: string }
  | { ok: false; status: number; message: string };

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

/** A local assistant's gateway base URL plus a token minted for it. */
export interface LocalGateway {
  base: string;
  token: string;
}

/**
 * Resolve a local/docker assistant's gateway and mint a token for it, for a
 * caller that makes many requests (a job poller) and should not mint per
 * request: every mint records a derived token in the gateway's database.
 */
export async function connectLocalGateway(
  assistant: LockfileAssistant,
): Promise<LocalGateway> {
  const base = localGatewayBase(assistant);
  return { base, token: await mintLocalGatewayToken(assistant, base) };
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
 * Ask a local/docker assistant's daemon to build a *debug* bundle and PUT it
 * to a signed URL: `POST /v1/migrations/export-to-gcs` with
 * `profile: "debug"`. The debug profile carries no credentials and adds the
 * gateway's database and logs, for Vellum staff to open on a debug clone.
 * Returns the 202 `job_id`; poll it with {@link pollLocalExportJob}.
 */
export async function exportLocalDebugBundle(
  assistant: LockfileAssistant,
  uploadUrl: string,
): Promise<string> {
  const base = localGatewayBase(assistant);
  const token = await mintLocalGatewayToken(assistant, base);
  const response = await fetch(`${base}/v1/migrations/export-to-gcs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ upload_url: uploadUrl, profile: "debug" }),
  });
  if (!response.ok) {
    throw new TeleportError(
      "export_failed",
      `Export failed (HTTP ${response.status}).`,
    );
  }
  const jobId = ((await safeJson(response)) as { job_id?: string } | null)
    ?.job_id;
  if (!jobId) {
    throw new TeleportError(
      "export_failed",
      "Export accepted but no job ID was returned.",
    );
  }
  return jobId;
}

/**
 * Poll a local/docker assistant's export job: `GET /v1/migrations/jobs/{id}`.
 * Resolves to the job status; throws once the job reports failure.
 */
export async function pollLocalExportJob(
  assistant: LockfileAssistant,
  jobId: string,
): Promise<string> {
  const job = await pollLocalMigrationJob(
    await connectLocalGateway(assistant),
    jobId,
    "export_job_failed",
  );
  if (job.status === "failed") {
    throw new TeleportError("export_job_failed", job.error ?? "Export failed");
  }
  return job.status;
}

/**
 * Read a migration job from a local gateway: `GET /v1/migrations/jobs/{id}`.
 * A 5xx reads as still processing so a poller rides out a transient gateway
 * error. Any other non-2xx, or a body that is not a job status, throws a
 * {@link TeleportError} carrying `failureCode`.
 */
export async function pollLocalMigrationJob(
  { base, token }: LocalGateway,
  jobId: string,
  failureCode: TeleportErrorCode,
): Promise<LocalMigrationJob> {
  const response = await fetch(
    `${base}/v1/migrations/jobs/${encodeURIComponent(jobId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (response.status >= 500) {
    return { status: "processing" };
  }
  if (!response.ok) {
    throw new TeleportError(
      failureCode,
      t("settings:teleportCard.jobStatusFailed", { status: response.status }),
    );
  }
  const job = LocalMigrationJobSchema.safeParse(await safeJson(response));
  if (!job.success) {
    throw new TeleportError(
      failureCode,
      t("settings:teleportCard.jobStatusInvalid"),
    );
  }
  return job.data;
}

/**
 * Ask a local runtime to fetch a `.vbundle` from a signed URL and
 * stream-import it as a background job: `POST /v1/migrations/import-from-gcs`
 * with `{bundle_url}`. The bundle bytes never pass through the renderer.
 * Resolves to the 202 `job_id` (poll it with {@link pollLocalMigrationJob}) or
 * to the status and message of a refusal. Throws when the gateway can't be
 * reached.
 */
export async function startLocalImportFromUrl(
  { base, token }: LocalGateway,
  bundleUrl: string,
): Promise<LocalImportStart> {
  const response = await fetch(`${base}/v1/migrations/import-from-gcs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bundle_url: bundleUrl }),
  });
  const body = await safeJson(response);
  if (response.status !== 202) {
    const refusal = LocalRuntimeErrorSchema.safeParse(body);
    return {
      ok: false,
      status: response.status,
      message: refusal.success
        ? refusal.data.error.message
        : t("settings:teleportCard.importFailedHttp", {
            status: response.status,
          }),
    };
  }
  const started = LocalImportStartedSchema.safeParse(body);
  if (!started.success) {
    return {
      ok: false,
      status: response.status,
      message: t("settings:teleportCard.importNoJobId"),
    };
  }
  return { ok: true, jobId: started.data.job_id };
}

/**
 * Take a gateway backup snapshot of a local assistant now:
 * `POST /v1/backups/create`. The gateway exports a fresh `.vbundle` and
 * writes it to its local backup pool plus any configured offsite
 * destinations, so this call blocks for the full export. Throws on a non-2xx
 * status or a `{success:false}` body.
 */
export async function createLocalBackup(
  assistant: LockfileAssistant,
): Promise<void> {
  const base = localGatewayBase(assistant);
  const token = await mintLocalGatewayToken(assistant, base);
  const response = await fetch(`${base}/v1/backups/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new TeleportError(
      "backup_failed",
      t("settings:teleportCard.backupLocalFailed", {
        status: response.status,
      }),
    );
  }
  const json = (await safeJson(response)) as { success?: boolean } | null;
  if (json && json.success === false) {
    throw new TeleportError(
      "backup_failed",
      t("settings:teleportCard.backupLocalReportedFailure"),
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
  if (status >= 500) {
    return "processing";
  } // transient — caller retries
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
