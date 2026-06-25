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

import { getAssistantHealthz, hatchAssistant } from "@/assistant/api";
import { retireAssistant } from "@/assistant/retire-service";
import { bootstrapLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";
import { getAppVersionInfo } from "@/runtime/app-info";
import {
  assistantsList,
  assistantsOperationalStatusDetailRead,
} from "@/generated/api/sdk.gen";
import {
  getLocalAssistants,
  getPlatformRuntimeUrl,
  getSelectedAssistant,
  loadLockfile,
  saveLockfileAssistant,
  setActiveLockfileAssistant,
} from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { hatchLocalAssistant } from "@/runtime/local-mode-host";
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
  /**
   * Whether this assistant was created by the teleport itself (a hatched
   * managed assistant, or a freshly-hatched local target). Only freshly-created
   * targets are retired when the user cancels — never a pre-existing assistant
   * the import wrote into.
   */
  createdFresh: boolean;
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
      createdFresh: false,
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
      // A failure after the target was created (e.g. import non-2xx, job
      // failure) would otherwise orphan the fresh assistant — and the retry
      // pre-check would then reject because it already exists. Clean it up the
      // same way Cancel does.
      await cleanupFreshTarget(
        targetRef.current,
        originalRef.current,
        "teleport-execute-cleanup",
      );
      targetRef.current = null;
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
      try {
        const auth = useAuthStore.getState();
        if (target.kind === "managed") {
          await auth.connectPlatformAssistant(target.id);
        } else {
          await auth.connectLocalAssistant(target.id);
          // The platform→local import strips `vellum:*` platform-identity
          // credentials, so the freshly-imported local has no platform identity.
          // Now that it's the active assistant, re-register it with the platform
          // and inject those credentials (the web equivalent of the CLI's
          // post-import injection) so managed/platform integrations keep working.
          // Best-effort: a failure here shouldn't block the switch.
          bootstrapLocalAssistantPlatformIdentity(target.id, {
            onError: (error) =>
              captureError(error, {
                context: "teleport-inject-platform-identity",
              }),
          });
        }
      } catch (error) {
        // The switch failed — keep the target around and surface the error
        // rather than leaving the UI stuck in the verifying phase.
        const message =
          error instanceof Error ? error.message : "Failed to switch assistant.";
        setPhase({ kind: "failed", error: `Switch failed: ${message}` });
        captureError(error, { context: "teleport-confirm-switch" });
        return;
      }

      // Fire-and-forget retirement of the source — mirrors the Swift flow,
      // which never blocks the switch on the old assistant going away.
      // `retireAssistant` (the retire service) also reconciles the lockfile +
      // resolved-assistants store, so the retired source stops being selectable.
      if (original) {
        void retireAssistant(original.id).then((result) => {
          if (!result.ok) {
            captureError(new Error(result.error), {
              context: "teleport-retire-source",
            });
          }
        });
      }

      reset();
      void navigate(routes.assistant, { replace: true });
    })();
  }, [navigate, reset]);

  const cancelTeleport = useCallback(() => {
    const target = targetRef.current;
    const original = originalRef.current;
    // Leave the verifying phase and clear the refs *synchronously*, before the
    // async retire/restore runs. Otherwise a Confirm & Switch click while
    // cleanup is in flight would connect to the same target and retire the
    // source — racing the cancel that's retiring the target, and potentially
    // switching the user to a retired assistant or deleting both sides.
    targetRef.current = null;
    originalRef.current = null;
    setPhase({ kind: "idle" });
    void cleanupFreshTarget(target, original, "teleport-cancel-retire-target");
  }, []);

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

// ---------------------------------------------------------------------------
// Local → Platform
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
  // already exists for this account. Query the platform directly rather than
  // `getAssistant()` — that helper short-circuits to the (local) selected
  // assistant while a local source is active, which would bypass this guard.
  setStep("Checking for existing assistant...");
  const platformList = await assistantsList({
    query: { hosting: "platform" },
    throwOnError: false,
  });
  const existingPlatform = platformList.data?.results?.[0];
  if (existingPlatform) {
    throw new TeleportError(
      "existing_platform_assistant",
      `You already have a platform assistant '${existingPlatform.id}'. Retire it first, then retry the teleport.`,
    );
  }

  setStep("Uploading data to cloud...");
  // Stamp the upload with the source runtime version so the platform records
  // the bundle's compat band for the download-side version-mismatch guard.
  const upload = await requestSignedUploadUrl(source.resources?.runtimeVersion);
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
  // `saveLockfileAssistant` marks the new entry active; keep the source active
  // until the user confirms the switch so a cancel/restart never lands on the
  // half-built target.
  await setActiveLockfileAssistant(source.assistantId);

  // Record the target now (not just at the end) so a failure during the
  // remaining steps cleans up this freshly-hatched managed assistant.
  targetRef.current = { id: managedId, kind: "managed", createdFresh: true };

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
  } else {
    // A synchronous 2xx can still report a validation/import failure in the
    // body (`{success:false}`); without this check the flow would advance to
    // verifying and let the user retire the source despite a failed import.
    const body = result.body as { success?: boolean; error?: string } | null;
    if (body && body.success === false) {
      throw new TeleportError(
        "import_failed",
        body.error ?? "Import reported failure.",
      );
    }
  }
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
  // Stamp the upload with the managed source's runtime version so the platform
  // records the bundle's compat band — without it the download-side
  // version-mismatch guard has nothing to compare against and a newer-cloud →
  // older-local import only fails late at runtime import.
  const sourceRuntimeVersion = await resolveRuntimeVersion(source.assistantId);
  const upload = await requestSignedUploadUrl(sourceRuntimeVersion);

  setStep("Exporting cloud data...");
  const jobId = await exportManagedToGcs(source.assistantId, upload.url);
  await awaitManagedExportJob(source.assistantId, jobId);

  // Resolve the local target BEFORE requesting the download so the version
  // check runs against the local *runtime* version, not the Electron shell.
  setStep("Preparing local assistant...");
  const { assistant: local, createdFresh } = await resolveLocalTarget();
  // Record the target now so a failure during download/import cleans up a
  // freshly-hatched local instead of orphaning it.
  targetRef.current = { id: local.assistantId, kind: "local", createdFresh };

  const targetRuntimeVersion = await resolveLocalTargetRuntimeVersion(
    local,
    createdFresh,
  );
  if (!targetRuntimeVersion) {
    throw new TeleportError(
      "local_assistant_not_found",
      "Could not determine the local assistant's runtime version. Restart or upgrade the local assistant, then retry the teleport.",
    );
  }

  setStep("Preparing import...");
  const downloadUrl = await requestSignedDownloadUrl(
    upload.bundleKey,
    targetRuntimeVersion,
  );

  setStep("Downloading data...");
  const bundle = await downloadFromSignedUrl(downloadUrl, setProgress);

  setStep("Importing data...");
  await importWithRetry(local, bundle);

  // Hatching/waking the local target may have flipped the active assistant;
  // keep the source active until the user confirms the switch.
  await setActiveLockfileAssistant(source.assistantId);
}

/**
 * The runtime version to validate a `platform → local` import against.
 *
 * A freshly-hatched local assistant runs the runtime bundled with this app, so
 * the bundled app version is its runtime version (matching the macOS original,
 * which used `Bundle.main` for the bundled local runtime). A pre-existing local
 * can have been upgraded independently of the app shell, so it must report its
 * own recorded `resources.runtimeVersion`; if it doesn't, return `undefined` so
 * the caller fails with a repairable error rather than comparing against the
 * wrong (shell) version.
 */
async function resolveLocalTargetRuntimeVersion(
  local: LockfileAssistant,
  createdFresh: boolean,
): Promise<string | undefined> {
  if (local.resources?.runtimeVersion) return local.resources.runtimeVersion;
  if (!createdFresh) return undefined;
  return (await getAppVersionInfo())?.version ?? undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discard a teleport target the user cancelled or that a failed transfer left
 * behind: retire it only if the teleport created it (never a pre-existing
 * assistant the import wrote into), then restore the original as the active
 * assistant. `retireAssistant` reconciles the lockfile + resolved-assistants
 * store so the target stops being selectable.
 */
async function cleanupFreshTarget(
  target: AssistantRef | null,
  original: AssistantRef | null,
  context: string,
): Promise<void> {
  if (target?.createdFresh) {
    const result = await retireAssistant(target.id);
    if (!result.ok) captureError(new Error(result.error), { context });
  }
  if (original) await setActiveLockfileAssistant(original.id);
}

/**
 * The runtime version reported by an assistant's gateway healthz, or
 * `undefined` if it can't be read. Used to stamp the bundle's compat band and
 * to validate the import target against the real runtime (not the app shell).
 */
async function resolveRuntimeVersion(
  assistantId: string,
): Promise<string | undefined> {
  const health = await getAssistantHealthz(assistantId);
  return health.ok ? (health.data.version ?? undefined) : undefined;
}

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
    // `pollJobStatus` already retries transient 5xx via `requestWithRetry`, so a
    // thrown error here is a permanent failure (expired session, 4xx, missing
    // job) — let it propagate and fail the teleport promptly rather than
    // swallowing it and grinding to the 60-minute timeout.
    const status = await pollJobStatus(jobId);
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
 * Hatch a fresh local assistant to receive the imported bundle.
 *
 * The import is destructive — it overwrites the target's workspace — and the
 * verification step doesn't undo it, so we never import into a pre-existing
 * local assistant (that would silently destroy data the user never chose to
 * replace). Always hatch a new local: it's `createdFresh`, so Cancel cleanly
 * retires it and the user's existing locals are left untouched.
 */
async function resolveLocalTarget(): Promise<{
  assistant: LockfileAssistant;
  createdFresh: boolean;
}> {
  const hatched = await hatchLocalAssistant(undefined, undefined);
  if (!hatched.ok) {
    throw new TeleportError(
      "local_assistant_not_found",
      hatched.error ?? "Could not create a local assistant.",
    );
  }
  await loadLockfile();
  // The just-hatched assistant is the newest local entry.
  const local = hatched.assistantId
    ? getLocalAssistants().find((a) => a.assistantId === hatched.assistantId)
    : newestLocalAssistant();
  if (!local) {
    throw new TeleportError(
      "local_assistant_not_found",
      "Could not find or create a local assistant.",
    );
  }
  return { assistant: local, createdFresh: true };
}

/**
 * The newest local assistant by `hatchedAt`. `getLocalAssistants()` preserves
 * lockfile order, which appends newly-hatched entries at the end — so a naive
 * `[0]` would target the *oldest* local. Sort newest-first to find the
 * just-hatched target when its id isn't reported back.
 */
function newestLocalAssistant(): LockfileAssistant | undefined {
  return getLocalAssistants()
    .slice()
    .sort((a, b) => (b.hatchedAt ?? "").localeCompare(a.hatchedAt ?? ""))[0];
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
