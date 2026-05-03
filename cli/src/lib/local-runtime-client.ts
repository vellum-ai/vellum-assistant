import type { AssistantEntry } from "./assistant-config.js";
import {
  authHeaders,
  invalidateOrgIdCache,
  parseUnifiedJobStatus,
  type UnifiedJobStatus,
} from "./platform-client.js";
import {
  resolveRuntimeMigrationUrl,
  resolveRuntimeUrl,
} from "./runtime-url.js";

/**
 * Thrown when the local runtime returns 409 for an export/import request
 * because another migration of the same type is already in-flight. The
 * caller can inspect {@link existingJobId} and decide whether to poll the
 * existing job instead of retrying.
 */
export class MigrationInProgressError extends Error {
  readonly existingJobId: string;
  readonly kind: "export_in_progress" | "import_in_progress";

  constructor(
    kind: "export_in_progress" | "import_in_progress",
    jobId: string,
  ) {
    super(
      `A migration is already in progress (${kind}); existing job_id=${jobId}`,
    );
    this.name = "MigrationInProgressError";
    this.kind = kind;
    this.existingJobId = jobId;
  }
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Build the auth + content headers for a runtime migration request.
 *
 * - For `cloud === "vellum"` we go through the platform's wildcard runtime
 *   proxy, which authenticates user-session / vak_ tokens via DRF's default
 *   authentication classes — `authHeaders()` produces the right combination
 *   (`X-Session-Token` + `Vellum-Organization-Id`, or `Authorization: Bearer
 *   vak_...`).
 * - For local/docker the runtime endpoint expects a guardian-token bearer.
 */
async function migrationRequestHeaders(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl">,
  token: string,
): Promise<Record<string, string>> {
  if (entry.cloud === "vellum") {
    return {
      ...(await authHeaders(token, entry.runtimeUrl)),
      Accept: "application/json",
    };
  }
  return bearerHeaders(token);
}

interface Raw409Body {
  detail?: string;
  // The runtime's current 409 contract nests the payload under `error`:
  //   { error: { code: "export_in_progress" | "import_in_progress", job_id } }
  // We also tolerate a legacy flat shape ({ code, job_id }) for resilience.
  error?: string | { code?: string; job_id?: string };
  code?: string;
  job_id?: string;
}

/** Common 409 → MigrationInProgressError parsing used by the two POST helpers. */
async function throwIfInProgress(
  response: Response,
  defaultKind: "export_in_progress" | "import_in_progress",
): Promise<void> {
  if (response.status !== 409) return;
  const body = (await response.json().catch(() => ({}))) as Raw409Body;
  const nested =
    typeof body.error === "object" && body.error !== null
      ? body.error
      : undefined;
  const jobId = nested?.job_id ?? body.job_id ?? "";
  const rawKind =
    nested?.code ??
    body.code ??
    (typeof body.error === "string" ? body.error : undefined) ??
    defaultKind;
  const kind: "export_in_progress" | "import_in_progress" =
    rawKind === "export_in_progress" || rawKind === "import_in_progress"
      ? rawKind
      : defaultKind;
  throw new MigrationInProgressError(kind, jobId);
}

/**
 * Kick off an async export-to-GCS job on the assistant's runtime.
 *
 * For local/docker assistants this POSTs to
 * `{runtimeUrl}/v1/migrations/export-to-gcs` with guardian-token bearer
 * auth. For platform-managed (cloud="vellum") assistants the URL is rewritten
 * to the wildcard-runtime-proxy shape
 * `{platformUrl}/v1/assistants/<assistantId>/migrations/export-to-gcs` and
 * authenticated via the platform-token header set the platform's DRF auth
 * accepts (session / vak_).
 *
 * Returns the 202-accepted `job_id`. On 409 (another export in flight)
 * throws {@link MigrationInProgressError} with the existing job_id.
 */
export async function localRuntimeExportToGcs(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  token: string,
  params: { uploadUrl: string; description?: string },
): Promise<{ jobId: string }> {
  const body: Record<string, unknown> = { upload_url: params.uploadUrl };
  if (params.description !== undefined) {
    body.description = params.description;
  }

  const response = await fetch(
    resolveRuntimeMigrationUrl(entry, "export-to-gcs"),
    {
      method: "POST",
      headers: await migrationRequestHeaders(entry, token),
      body: JSON.stringify(body),
    },
  );

  await throwIfInProgress(response, "export_in_progress");

  if (response.status !== 202) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Local runtime export-to-gcs failed (${response.status}): ${
        errText || response.statusText
      }`,
    );
  }

  const json = (await response.json()) as {
    job_id: string;
    status?: string;
    type?: string;
  };
  return { jobId: json.job_id };
}

/**
 * Kick off an async import-from-GCS job on the assistant's runtime.
 *
 * For local/docker assistants this POSTs to
 * `{runtimeUrl}/v1/migrations/import-from-gcs` with guardian-token bearer
 * auth. For platform-managed (cloud="vellum") assistants the URL is rewritten
 * to the wildcard-runtime-proxy shape
 * `{platformUrl}/v1/assistants/<assistantId>/migrations/import-from-gcs` and
 * authenticated via the platform token. On 409 throws
 * {@link MigrationInProgressError}.
 */
export async function localRuntimeImportFromGcs(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  token: string,
  params: { bundleUrl: string },
): Promise<{ jobId: string }> {
  const response = await fetch(
    resolveRuntimeMigrationUrl(entry, "import-from-gcs"),
    {
      method: "POST",
      headers: await migrationRequestHeaders(entry, token),
      body: JSON.stringify({ bundle_url: params.bundleUrl }),
    },
  );

  await throwIfInProgress(response, "import_in_progress");

  if (response.status !== 202) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Local runtime import-from-gcs failed (${response.status}): ${
        errText || response.statusText
      }`,
    );
  }

  const json = (await response.json()) as {
    job_id: string;
    status?: string;
    type?: string;
  };
  return { jobId: json.job_id };
}

/**
 * Poll the runtime's unified job-status endpoint.
 *
 * For local/docker assistants this GETs
 * `{runtimeUrl}/v1/migrations/jobs/{jobId}` directly (guardian-token
 * bearer). For platform-managed assistants it routes through the wildcard
 * runtime proxy at
 * `{platformUrl}/v1/assistants/<assistantId>/migrations/jobs/{jobId}` with
 * platform-token auth — important: the platform's dedicated
 * `/v1/migrations/jobs/{id}/` endpoint queries platform-side ImportJob
 * records and would 404 on runtime-created job IDs.
 */
export async function localRuntimePollJobStatus(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  token: string,
  jobId: string,
): Promise<UnifiedJobStatus> {
  const response = await fetch(
    resolveRuntimeMigrationUrl(entry, `jobs/${jobId}`),
    {
      headers: await migrationRequestHeaders(entry, token),
    },
  );

  if (response.status === 404) {
    throw new Error("Migration job not found");
  }

  if (!response.ok) {
    throw new Error(
      `Local job status check failed: ${response.status} ${response.statusText}`,
    );
  }

  const raw = (await response.json()) as Parameters<
    typeof parseUnifiedJobStatus
  >[0];
  return parseUnifiedJobStatus(raw);
}

/**
 * The subset of `/v1/health` we care about. The runtime's full response
 * includes additional fields (status, disk, memory, cpu, migrations, etc.)
 * — we only model `version` here because that's all the CLI consumes today.
 */
export interface RuntimeIdentity {
  version: string;
}

/**
 * Fetch the target runtime's APP_VERSION via `/v1/health`. Used by
 * `vellum teleport` and `vellum backup` to stamp the exported bundle's
 * `min_runtime_version` with the version of the runtime that actually
 * produced it — which can diverge from the orchestrating CLI's version when
 * the target was upgraded independently.
 *
 * GETs `/v1/health` (not `/v1/identity`) so the call works on freshly-
 * hatched runtimes that haven't completed onboarding. The `/v1/identity`
 * handler reads `IDENTITY.md` from the workspace and 404s if it's missing
 * — and `IDENTITY.md` is only written during onboarding, not hatch. The
 * `/v1/health` handler returns the same `version` field unconditionally
 * (no filesystem reads), so it's safe to call against any running runtime.
 *
 * For local/docker assistants this GETs `{runtimeUrl}/v1/health` with
 * guardian-token bearer auth. For platform-managed (cloud="vellum")
 * assistants the URL is rewritten to the wildcard runtime proxy shape
 * `{platformUrl}/v1/assistants/<assistantId>/health` and authenticated via
 * the platform token.
 *
 * For the vellum target this is the FIRST network call in the
 * teleport/backup export flow, so a stale `Vellum-Organization-Id` cache
 * entry would surface as a hard abort before any retry-friendly call (like
 * `platformRequestSignedUrl`) gets a chance to recover. Mirror that helper's
 * one-shot 401-retry: invalidate the org-ID cache and retry once. Local /
 * docker entries do not use the org-ID cache and are wrapped in
 * `callRuntimeWithAuthRetry` by callers for guardian-token refresh, so the
 * retry is intentionally vellum-only.
 *
 * The function name is intentionally retained ("identity-ish info about the
 * runtime") even though the implementation now hits `/v1/health` — renaming
 * would force changes in 4+ callsites for no behavioral benefit.
 *
 * Throws on non-2xx so callers can surface the failure (we never silently
 * fall back — see teleport.ts call site).
 */
export async function localRuntimeIdentity(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  token: string,
): Promise<RuntimeIdentity> {
  const url = resolveRuntimeUrl(entry, "health");
  const doRequest = async (): Promise<Response> =>
    fetch(url, {
      method: "GET",
      headers: await migrationRequestHeaders(entry, token),
    });

  let response = await doRequest();
  if (response.status === 401 && entry.cloud === "vellum") {
    // `entry.runtimeUrl` is the platform host for vellum-cloud entries
    // (the wildcard runtime proxy lives there). Pass it as the cache key
    // platformUrl so we invalidate the same entry that authHeaders cached.
    invalidateOrgIdCache(token, entry.runtimeUrl);
    response = await doRequest();
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch runtime identity: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !body.version) {
    throw new Error("Runtime identity response missing version");
  }
  return { version: body.version };
}
