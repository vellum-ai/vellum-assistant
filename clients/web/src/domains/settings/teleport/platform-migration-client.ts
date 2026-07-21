/**
 * Client for the platform's org-scoped migration endpoints, ported from the
 * macOS `PlatformMigrationClient.swift`.
 *
 * The JSON control-plane calls (`signed-url`, `import-from-gcs`, `jobs`) go
 * through the generated API `client` so the central interceptor attaches the
 * session + organization auth headers — those headers must never be set by
 * feature code. The binary data-plane (`PUT`/`GET` of bundle bytes) talks
 * directly to the GCS signed URLs, which carry their own auth in the URL and
 * need no Vellum headers.
 */

import { client } from "@/generated/api/client.gen";

import { readArrayBufferWithProgress } from "./bundle-stream";
import { parseVersionMismatch, TeleportError } from "./teleport-types";

/** Response from the platform's unified signed-URL endpoint. */
export interface SignedUrlResponse {
  /** Signed URL for a direct GCS PUT/GET of bundle bytes. */
  url: string;
  /** Opaque bundle key the runtime/platform use to reference the object. */
  bundleKey: string;
  /** ISO-8601 expiry of the signed URL. */
  expiresAt: string;
}

/** Status of an async migration job returned by the unified job-status endpoint. */
export interface JobStatus {
  status: string;
  jobId: string | null;
  error: string | null;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ClientResult {
  response?: Response;
  data?: unknown;
  error?: unknown;
}

/**
 * Run a generated-client call with retry on transient 5xx server errors, using
 * the same 1s/2s/4s exponential backoff as the Swift client. `nonRetryable`
 * lets callers treat specific codes (e.g. 422 version-mismatch, 404/503
 * unavailable) as permanent semantic signals rather than transient errors.
 */
async function requestWithRetry(
  call: () => Promise<ClientResult>,
  nonRetryable: Set<number> = new Set(),
): Promise<{ status: number; data: unknown; error: unknown }> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { response, data, error } = await call();
    const status = response?.status ?? 0;
    if (
      attempt < MAX_RETRIES &&
      RETRYABLE_STATUS.has(status) &&
      !nonRetryable.has(status)
    ) {
      await sleep(2 ** attempt * 1000);
      continue;
    }
    return { status, data, error };
  }
  throw new TeleportError("unknown", "Unexpected retry loop exit");
}

/**
 * Request a signed upload URL: `POST /v1/migrations/signed-url/` with
 * `{operation:"upload"}`. The returned URL is suitable for a direct GCS PUT.
 *
 * `sourceRuntimeVersion` stamps the bundle's compat band (`min_runtime_version`
 * with no upper bound) so the later download-side `target_runtime_version`
 * check can enforce a real version-mismatch guard — matching the CLI teleport
 * path, which sends the source runtime version before upload.
 */
export async function requestSignedUploadUrl(
  sourceRuntimeVersion?: string,
  /**
   * Who will PUT to the URL. `"runtime"` signs against the runtime-reachable
   * storage endpoint so a managed assistant pod can upload its export bundle
   * (platform→local teleport); the default (`"client"`) signs for a browser
   * upload. No effect in production, where both endpoints are the same.
   */
  consumer?: "client" | "runtime",
): Promise<SignedUrlResponse> {
  const body: Record<string, unknown> = { operation: "upload" };
  if (sourceRuntimeVersion) {
    body.min_runtime_version = sourceRuntimeVersion;
    body.max_runtime_version = null;
  }
  if (consumer) {
    body.consumer = consumer;
  }
  const { status, data } = await requestWithRetry(
    () =>
      client.post<unknown, unknown, false>({
        url: "/v1/migrations/signed-url/",
        body,
        throwOnError: false,
      }),
    new Set([404, 503]),
  );

  if (status === 503 || status === 404) {
    throw new TeleportError(
      "export_failed",
      "Signed URL uploads are not available — the platform may not support this feature yet.",
    );
  }
  if (status !== 201) {
    throw new TeleportError(
      "export_failed",
      `Migration request failed (HTTP ${status}).`,
    );
  }
  const json = data as { url: string; bundle_key: string; expires_at: string };
  return { url: json.url, bundleKey: json.bundle_key, expiresAt: json.expires_at };
}

/**
 * Request a signed download URL: `POST /v1/migrations/signed-url/` with
 * `{operation:"download", bundle_key, target_runtime_version}`. The platform
 * validates the bundle's runtime-compat range against the target runtime and
 * rejects with 422 + `reason:"version_mismatch"` when there's no overlap.
 */
export async function requestSignedDownloadUrl(
  bundleKey: string,
  targetRuntimeVersion: string,
): Promise<string> {
  const { status, data, error } = await requestWithRetry(
    () =>
      client.post<unknown, unknown, false>({
        url: "/v1/migrations/signed-url/",
        body: {
          operation: "download",
          bundle_key: bundleKey,
          target_runtime_version: targetRuntimeVersion,
        },
        throwOnError: false,
      }),
    new Set([422]),
  );

  if (status === 422) {
    const message = parseVersionMismatch(error);
    if (message) throw new TeleportError("version_mismatch", message);
  }
  if (status !== 200 && status !== 201) {
    throw new TeleportError(
      "import_failed",
      `Migration request failed (HTTP ${status}).`,
    );
  }
  return (data as { url: string }).url;
}

/**
 * Upload bundle bytes to a GCS signed URL via `PUT`, reporting progress through
 * `onProgress` (0..1). Uses `XMLHttpRequest` because `fetch` can't report
 * upload progress. Retries transient 5xx with the same backoff as the Swift
 * client.
 */
export async function uploadToSignedUrl(
  url: string,
  bundle: ArrayBuffer | Blob,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const status = await putWithProgress(url, bundle, onProgress);
    if (attempt < MAX_RETRIES && RETRYABLE_STATUS.has(status)) {
      await sleep(2 ** attempt * 1000);
      onProgress?.(0);
      continue;
    }
    if (status < 200 || status >= 300) {
      throw new TeleportError(
        "export_failed",
        `Bundle upload failed (HTTP ${status}).`,
      );
    }
    return;
  }
}

function putWithProgress(
  url: string,
  bundle: ArrayBuffer | Blob,
  onProgress?: (fraction: number) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 3_600_000;
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      onProgress?.(1);
      resolve(xhr.status);
    };
    xhr.onerror = () =>
      reject(new TeleportError("export_failed", "Bundle upload failed."));
    xhr.ontimeout = () =>
      reject(new TeleportError("export_timed_out", "Bundle upload timed out."));
    xhr.send(bundle);
  });
}

/**
 * Download bundle bytes from a GCS signed URL via `GET`, reporting progress
 * through `onProgress` (0..1) by streaming the response body. Retries transient
 * 5xx with the same backoff as the Swift client.
 */
export async function downloadFromSignedUrl(
  url: string,
  onProgress?: (fraction: number) => void,
): Promise<ArrayBuffer> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, { method: "GET" });
    if (attempt < MAX_RETRIES && RETRYABLE_STATUS.has(response.status)) {
      await sleep(2 ** attempt * 1000);
      onProgress?.(0);
      continue;
    }
    if (!response.ok) {
      throw new TeleportError(
        "import_failed",
        `Bundle download failed (HTTP ${response.status}).`,
      );
    }
    return readArrayBufferWithProgress(response, onProgress);
  }
  throw new TeleportError("import_failed", "Unexpected retry loop exit");
}

/**
 * Trigger a GCS-based import on the platform after the bundle has been
 * uploaded: `POST /v1/migrations/import-from-gcs/` with `{bundle_key}`.
 */
export async function importFromGcs(
  bundleKey: string,
): Promise<{ status: number; body: unknown }> {
  const { status, data, error } = await requestWithRetry(() =>
    client.post<unknown, unknown, false>({
      url: "/v1/migrations/import-from-gcs/",
      body: { bundle_key: bundleKey },
      throwOnError: false,
    }),
  );
  return { status, body: data ?? error ?? null };
}

/** Poll an async platform migration job: `GET /v1/migrations/jobs/{jobId}/`. */
export async function pollJobStatus(jobId: string): Promise<JobStatus> {
  const { status, data } = await requestWithRetry(() =>
    client.get<unknown, unknown, false>({
      url: "/v1/migrations/jobs/{job_id}/",
      path: { job_id: jobId },
      throwOnError: false,
    }),
  );
  if (status !== 200) {
    throw new TeleportError(
      "import_failed",
      `Job status check failed (HTTP ${status})`,
    );
  }
  const json = (data ?? {}) as Record<string, unknown>;
  return {
    status: typeof json.status === "string" ? json.status : "unknown",
    jobId: typeof json.job_id === "string" ? json.job_id : null,
    error: typeof json.error === "string" ? json.error : null,
  };
}
