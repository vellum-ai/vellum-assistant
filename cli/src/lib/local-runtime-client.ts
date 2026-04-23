import {
  parseUnifiedJobStatus,
  type UnifiedJobStatus,
} from "./platform-client.js";

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
 * Kick off an async export-to-GCS job on the local runtime.
 * POSTs to `{runtimeUrl}/v1/migrations/export-to-gcs` and returns the
 * 202-accepted job_id. On 409 (another export in flight) throws
 * {@link MigrationInProgressError} with the existing job_id.
 */
export async function localRuntimeExportToGcs(
  runtimeUrl: string,
  token: string,
  params: { uploadUrl: string; description?: string },
): Promise<{ jobId: string }> {
  const body: Record<string, unknown> = { upload_url: params.uploadUrl };
  if (params.description !== undefined) {
    body.description = params.description;
  }

  const response = await fetch(`${runtimeUrl}/v1/migrations/export-to-gcs`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify(body),
  });

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
 * Kick off an async import-from-GCS job on the local runtime.
 * POSTs to `{runtimeUrl}/v1/migrations/import-from-gcs` with a signed
 * download URL. On 409 throws {@link MigrationInProgressError}.
 */
export async function localRuntimeImportFromGcs(
  runtimeUrl: string,
  token: string,
  params: { bundleUrl: string },
): Promise<{ jobId: string }> {
  const response = await fetch(`${runtimeUrl}/v1/migrations/import-from-gcs`, {
    method: "POST",
    headers: bearerHeaders(token),
    body: JSON.stringify({ bundle_url: params.bundleUrl }),
  });

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
 * Poll the local runtime's unified job-status endpoint.
 * GETs `{runtimeUrl}/v1/migrations/jobs/{jobId}` and parses into
 * {@link UnifiedJobStatus}.
 */
export async function localRuntimePollJobStatus(
  runtimeUrl: string,
  token: string,
  jobId: string,
): Promise<UnifiedJobStatus> {
  const response = await fetch(`${runtimeUrl}/v1/migrations/jobs/${jobId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

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
