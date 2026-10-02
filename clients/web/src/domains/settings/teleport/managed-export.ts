/**
 * Export a managed (cloud) assistant's current state to a `.vbundle` in
 * platform object storage. Shared by the platform → local teleport and the
 * backups card's Export button.
 *
 * The managed runtime builds the bundle and PUTs it to a runtime-consumer
 * signed URL, so the browser never handles the bytes on the export side.
 * Managed exports carry no credentials.
 */

import { getAssistantHealthz } from "@/assistant/api";
import { t } from "@/i18n";

import { requestSignedUploadUrl } from "./platform-migration-client";
import {
  exportManagedToGcs,
  pollManagedExportJob,
} from "./teleport-gateway-client";
import { TeleportError } from "./teleport-types";

const MANAGED_EXPORT_POLL_INTERVAL_MS = 5_000;
const MANAGED_EXPORT_TIMEOUT_MS = 3_600_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type ManagedExportStep = "preparing" | "exporting";

export interface ManagedExportOptions {
  onStep?: (step: ManagedExportStep) => void;
  /** How often to poll the runtime's export job. */
  pollIntervalMs?: number;
  /** How long to wait for the export job before giving up. */
  timeoutMs?: number;
}

export interface ManagedExportResult {
  /** Key of the uploaded bundle, used to mint a signed download URL. */
  bundleKey: string;
  /** The source runtime's version, or `undefined` if it couldn't be read. */
  runtimeVersion: string | undefined;
}

/**
 * The runtime version reported by an assistant's gateway healthz, or
 * `undefined` if it can't be read. Used to stamp the bundle's compat band and
 * to validate an import target against the real runtime (not the app shell).
 */
async function resolveRuntimeVersion(
  assistantId: string,
): Promise<string | undefined> {
  const health = await getAssistantHealthz(assistantId);
  return health.ok ? (health.data.version ?? undefined) : undefined;
}

/** Run a managed export end to end and resolve once the bundle is uploaded. */
export async function exportManagedBundle(
  assistantId: string,
  {
    onStep,
    pollIntervalMs = MANAGED_EXPORT_POLL_INTERVAL_MS,
    timeoutMs = MANAGED_EXPORT_TIMEOUT_MS,
  }: ManagedExportOptions = {},
): Promise<ManagedExportResult> {
  onStep?.("preparing");
  // Stamping the upload with the source runtime version records the bundle's
  // compat band, so the download-side version guard has something to compare.
  const runtimeVersion = await resolveRuntimeVersion(assistantId);
  // The managed pod PUTs the bundle, so the URL is signed for the
  // runtime-reachable storage endpoint.
  const upload = await requestSignedUploadUrl(runtimeVersion, "runtime");

  onStep?.("exporting");
  const jobId = await exportManagedToGcs(assistantId, upload.url);
  await awaitManagedExportJob(assistantId, jobId, pollIntervalMs, timeoutMs);

  return { bundleKey: upload.bundleKey, runtimeVersion };
}

async function awaitManagedExportJob(
  assistantId: string,
  jobId: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollIntervalMs);
    const status = await pollManagedExportJob(assistantId, jobId);
    if (status === "complete") {
      return;
    }
  }
  throw new TeleportError(
    "export_timed_out",
    t("settings:teleportCard.exportTimedOut"),
  );
}

/**
 * A browser save-as filename for an exported bundle:
 * `<label>-YYYY-MM-DD.vbundle`, restricted to the characters the platform
 * accepts for `download_filename` (`[A-Za-z0-9._-]`, alphanumeric first).
 */
export function exportBundleFilename(label: string, date: Date): string {
  const safeLabel = label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  const day = date.toISOString().slice(0, 10);
  return `${safeLabel || "assistant"}-${day}.vbundle`;
}
