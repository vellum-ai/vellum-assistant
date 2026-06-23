/**
 * Orchestration hook for teleport, ported from `TeleportSection.swift`.
 *
 * Drives the phase state machine (idle → transferring → verifying → switched,
 * or → failed) and runs the per-direction transfer flows. Like the Swift
 * original, the source assistant is preserved until the user confirms the new
 * one works; "Confirm & Switch" then switches to the target and retires the
 * source, while "Cancel" discards the target.
 */

import { type MutableRefObject, useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { getAssistant, hatchAssistant, retireAssistantById } from "@/assistant/api";
import { assistantsOperationalStatusDetailRead } from "@/generated/api/sdk.gen";
import {
  getLocalAssistants,
  getPlatformRuntimeUrl,
  getSelectedAssistant,
  loadLockfile,
  saveLockfileAssistant,
} from "@/lib/local-mode";
import { getAppVersionInfo } from "@/runtime/app-info";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import {
  hatchLocalAssistant,
  retireLocalAssistantHost,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import { useAuthStore } from "@/stores/auth-store";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";
import { captureError } from "@/lib/sentry/capture-error";
import { routes } from "@/utils/routes";

import {
  classifyHosting,
  resolveDestination,
  TeleportError,
  type TeleportDestination,
  type TeleportPhase,
} from "./teleport-types";
import {
  exportLocalBundle,
  exportManagedToGcs,
  importLocalBundle,
  pollManagedExportJob,
} from "./teleport-gateway-client";
import {
  downloadFromSignedUrl,
  importFromGcs,
  pollJobStatus,
  requestSignedDownloadUrl,
  requestSignedUploadUrl,
  uploadToSignedUrl,
} from "./platform-migration-client";

/** Reference to a teleport endpoint plus how to reach/retire it. */
interface AssistantRef {
  id: string;
  kind: "managed" | "local";
}

const POLL_INTERVAL_MS = 5_000;
const JOB_TIMEOUT_MS = 3_600_000;
const PROVISION_TIMEOUT_MS = 5 * 60_000;
const GATEWAY_READY_ATTEMPTS = 30;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface TeleportController {
  destination: TeleportDestination | null;
  phase: TeleportPhase;
  confirmOpen: boolean;
  requestTeleport: () => void;
  cancelConfirm: () => void;
  confirm: () => void;
  confirmAndSwitch: () => void;
  cancelTeleport: () => void;
  reset: () => void;
}

export function useTeleport(): TeleportController {
  const navigate = useNavigate();
  const source = getSelectedAssistant();
  const destination = resolveDestination(source?.cloud);

  const [phase, setPhase] = useState<TeleportPhase>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const targetRef = useRef<AssistantRef | null>(null);
  const originalRef = useRef<AssistantRef | null>(null);

  const setStep = useCallback((step: string) => {
    setPhase({ kind: "transferring", step, progress: null });
  }, []);

  const setProgress = useCallback((progress: number) => {
    setPhase((prev) =>
      prev.kind === "transferring" ? { ...prev, progress } : prev,
    );
  }, []);

  const execute = useCallback(async () => {
    if (!source || !destination) return;
    originalRef.current = {
      id: source.assistantId,
      kind: classifyHosting(source.cloud) === "managed" ? "managed" : "local",
    };
    try {
      if (destination === "platform") {
        await teleportToPlatform(source, setStep, setProgress, targetRef);
      } else if (destination === "local") {
        await teleportToLocal(source, setStep, setProgress, targetRef);
      } else {
        throw new TeleportError("unknown", "Unsupported teleport destination.");
      }
      setPhase({ kind: "verifying" });
    } catch (error) {
      const message =
        error instanceof TeleportError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Teleport failed.";
      setPhase({ kind: "failed", error: `Teleport failed: ${message}` });
      captureError(error, { context: "teleport-execute" });
    }
  }, [source, destination, setStep, setProgress]);

  const requestTeleport = useCallback(() => setConfirmOpen(true), []);
  const cancelConfirm = useCallback(() => setConfirmOpen(false), []);

  const confirm = useCallback(() => {
    setConfirmOpen(false);
    void execute();
  }, [execute]);

  const reset = useCallback(() => {
    targetRef.current = null;
    originalRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  const confirmAndSwitch = useCallback(() => {
    const target = targetRef.current;
    const original = originalRef.current;
    if (!target) return;

    void (async () => {
      const auth = useAuthStore.getState();
      if (target.kind === "managed") {
        await auth.connectPlatformAssistant(target.id);
      } else {
        await auth.connectLocalAssistant(target.id);
      }

      // Fire-and-forget retirement of the source — mirrors the Swift flow,
      // which never blocks the switch on the old assistant going away.
      if (original) {
        void retireSource(original).catch((error) =>
          captureError(error, { context: "teleport-retire-source" }),
        );
      }

      reset();
      void navigate(routes.assistant, { replace: true });
    })();
  }, [navigate, reset]);

  const cancelTeleport = useCallback(() => {
    reset();
  }, [reset]);

  return {
    destination,
    phase,
    confirmOpen,
    requestTeleport,
    cancelConfirm,
    confirm,
    confirmAndSwitch,
    cancelTeleport,
    reset,
  };
}

async function retireSource(original: AssistantRef): Promise<void> {
  if (original.kind === "managed") {
    await retireAssistantById(original.id);
  } else {
    await retireLocalAssistantHost(original.id);
  }
}

// ---------------------------------------------------------------------------
// Local / Docker → Platform
// ---------------------------------------------------------------------------

async function teleportToPlatform(
  source: LockfileAssistant,
  setStep: (step: string) => void,
  setProgress: (fraction: number) => void,
  targetRef: MutableRefObject<AssistantRef | null>,
): Promise<void> {
  setStep("Exporting assistant data...");
  const bundle = await exportLocalBundle(source, setProgress);

  setStep("Resolving organization...");
  const organizationId = await resolveOrganizationId();

  // Pre-check before the expensive upload: block if a platform assistant
  // already exists for this account.
  setStep("Checking for existing assistant...");
  const existing = await getAssistant();
  if (existing.ok && existing.data && existing.data.is_local === false) {
    throw new TeleportError(
      "existing_platform_assistant",
      `You already have a platform assistant '${existing.data.id}'. Retire it first, then retry the teleport.`,
    );
  }

  setStep("Uploading data to cloud...");
  const upload = await requestSignedUploadUrl();
  await uploadToSignedUrl(upload.url, bundle, setProgress);

  setStep("Setting up cloud assistant...");
  const hatch = await hatchAssistant(undefined, "create");
  if (!hatch.ok) {
    throw new TeleportError(
      "import_failed",
      "Failed to set up the cloud assistant.",
    );
  }
  if (hatch.status === 200) {
    // Server deduped to an existing managed assistant — mirror the Swift
    // defensive guard and block rather than silently importing into it.
    throw new TeleportError(
      "existing_platform_assistant",
      `You already have a platform assistant '${hatch.data.id}'. Retire it first, then retry the teleport.`,
    );
  }
  const managedId = hatch.data.id;
  await saveLockfileAssistant({
    assistantId: managedId,
    name: hatch.data.name,
    cloud: "vellum",
    runtimeUrl: getPlatformRuntimeUrl(),
    hatchedAt: hatch.data.created ?? new Date().toISOString(),
    organizationId,
  });

  // Wait for post-hatch provisioning to finish before importing — otherwise the
  // import's workspace swap can race the runtime's secret provisioning.
  setStep("Finalizing cloud assistant...");
  await awaitAssistantProvisioned(managedId);

  setStep("Importing data to cloud...");
  const result = await importFromGcs(upload.bundleKey);
  if (result.status < 200 || result.status >= 300) {
    const body = result.body as { error?: string } | null;
    throw new TeleportError(
      "import_failed",
      body?.error ?? `Import failed (HTTP ${result.status}).`,
    );
  }
  if (result.status === 202) {
    const jobId = (result.body as { job_id?: string } | null)?.job_id;
    if (!jobId) {
      throw new TeleportError(
        "import_failed",
        "Import accepted but no job ID returned.",
      );
    }
    await awaitPlatformJob(jobId);
  }

  targetRef.current = { id: managedId, kind: "managed" };
}

// ---------------------------------------------------------------------------
// Platform → Local
// ---------------------------------------------------------------------------

async function teleportToLocal(
  source: LockfileAssistant,
  setStep: (step: string) => void,
  setProgress: (fraction: number) => void,
  targetRef: MutableRefObject<AssistantRef | null>,
): Promise<void> {
  setStep("Preparing export...");
  const upload = await requestSignedUploadUrl();

  setStep("Exporting cloud data...");
  const jobId = await exportManagedToGcs(source.assistantId, upload.url);
  await awaitManagedExportJob(source.assistantId, jobId);

  // The bundled app version is the local runtime version that will perform the
  // import — used to enforce the bundle's compat range.
  const versionInfo = await getAppVersionInfo();
  const targetRuntimeVersion = versionInfo?.version ?? "0.0.0";

  setStep("Preparing import...");
  const downloadUrl = await requestSignedDownloadUrl(
    upload.bundleKey,
    targetRuntimeVersion,
  );

  setStep("Downloading data...");
  const bundle = await downloadFromSignedUrl(downloadUrl, setProgress);

  setStep("Preparing local assistant...");
  const local = await resolveLocalTarget();

  setStep("Importing data...");
  await importWithRetry(local, bundle);

  targetRef.current = { id: local.assistantId, kind: "local" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and validate the organization id, mirroring the Swift logic: use the
 * connected org if valid; otherwise re-resolve — exactly one org is required.
 */
async function resolveOrganizationId(): Promise<string> {
  const store = useOrganizationStore.getState();
  if (store.organizations.length === 0) await store.fetchOrganizations();
  const orgs = useOrganizationStore.getState().organizations;

  const connected = getActiveOrganizationIdForRequests();
  if (connected && orgs.some((org) => org.id === connected)) return connected;

  if (orgs.length === 0) {
    throw new TeleportError(
      "no_organizations",
      "No organizations found for this account.",
    );
  }
  if (orgs.length > 1) {
    throw new TeleportError(
      "multiple_organizations",
      "Multiple organizations found — please select one in account settings first.",
    );
  }
  const orgId = orgs[0]!.id;
  useOrganizationStore.getState().setCurrentOrganizationId(orgId);
  return orgId;
}

/** Poll operational status until the managed assistant is provisioned/active. */
async function awaitAssistantProvisioned(assistantId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < PROVISION_TIMEOUT_MS) {
    const { data, response } = await assistantsOperationalStatusDetailRead({
      path: { id: assistantId },
      throwOnError: false,
    });
    if (response?.ok && data?.state === "active") return;
    await sleep(POLL_INTERVAL_MS);
  }
  // Timed out — proceed anyway; the import will surface a hard error if the
  // runtime genuinely isn't ready, matching the Swift best-effort wait.
}

/** Poll a platform migration job until complete, mirroring Swift `importBundleToManaged`. */
async function awaitPlatformJob(jobId: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < JOB_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    let status;
    try {
      status = await pollJobStatus(jobId);
    } catch {
      continue; // transient — retry
    }
    if (status.status === "complete") return;
    if (status.status === "failed") {
      throw new TeleportError(
        "import_failed",
        status.error ?? "Import job failed",
      );
    }
  }
  throw new TeleportError("import_failed", "Import timed out after 60 minutes.");
}

/** Poll a managed runtime-local export job until complete. */
async function awaitManagedExportJob(
  managedId: string,
  jobId: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < JOB_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const status = await pollManagedExportJob(managedId, jobId);
    if (status === "complete") return;
  }
  throw new TeleportError("export_timed_out", "Export timed out.");
}

/**
 * Resolve (or hatch, or wake) the local assistant that will receive the
 * imported bundle. Mirrors the Swift "newest local, else hatch, else wake".
 */
async function resolveLocalTarget(): Promise<LockfileAssistant> {
  let local = getLocalAssistants()[0];
  if (!local) {
    const hatched = await hatchLocalAssistant(undefined, undefined);
    if (!hatched.ok) {
      throw new TeleportError(
        "local_assistant_not_found",
        hatched.error ?? "Could not create a local assistant.",
      );
    }
    await loadLockfile();
    local = getLocalAssistants()[0];
  } else {
    await wakeLocalAssistantHost(local.assistantId);
  }
  if (!local) {
    throw new TeleportError(
      "local_assistant_not_found",
      "Could not find or create a local assistant.",
    );
  }
  return local;
}

/** Import with a short readiness retry, in lieu of an explicit healthz gate. */
async function importWithRetry(
  local: LockfileAssistant,
  bundle: ArrayBuffer,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < GATEWAY_READY_ATTEMPTS; attempt++) {
    try {
      await importLocalBundle(local, bundle);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new TeleportError("import_failed", "Import failed.");
}
