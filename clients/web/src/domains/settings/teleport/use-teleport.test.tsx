/**
 * Flow tests for the platform → local teleport in `useTeleport`: the managed
 * export, the signed download URL checked against the local runtime version,
 * the runtime-side import, and cleanup of the freshly hatched local when a step
 * fails. Every transport the hook reaches is `mock.module`-replaced.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import type * as AssistantApi from "@/assistant/api";
import type * as RetireService from "@/assistant/retire-service";
import type * as Sdk from "@/generated/api/sdk.gen";
import type * as LocalMode from "@/lib/local-mode";
import type * as LocalPlatformIdentity from "@/lib/local-platform-identity";
import type * as CaptureError from "@/lib/sentry/capture-error";
import type * as AppInfo from "@/runtime/app-info";
import type * as LocalModeHost from "@/runtime/local-mode-host";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import type * as AuthStore from "@/stores/auth-store";
import type * as OrganizationStore from "@/stores/organization-store";

import type * as LocalImport from "./local-import";
import type * as ManagedExport from "./managed-export";
import type * as PlatformMigrationClient from "./platform-migration-client";
import type * as TeleportBackup from "./teleport-backup";
import type * as GatewayClient from "./teleport-gateway-client";
import type * as TeleportSuccessor from "./teleport-successor";
import type { TeleportPhase } from "./teleport-types";

const SOURCE = {
  assistantId: "ast-managed",
  cloud: "vellum",
} as unknown as LockfileAssistant;
const BUNDLE_KEY = "uploads/org-abc/bundle.vbundle";
const BUNDLE_URL =
  "https://storage.googleapis.com/bucket/uploads/org-abc/bundle.vbundle?sig=abc";

let localEntry: LockfileAssistant;

const ensureSourceBackupMock = mock(async (_source: LockfileAssistant) => {});
const exportManagedBundleMock = mock(
  async (
    _assistantId: string,
    _options?: Parameters<typeof ManagedExport.exportManagedBundle>[1],
  ) => ({ bundleKey: BUNDLE_KEY, runtimeVersion: "1.2.3" }),
);
const hatchLocalAssistantMock = mock(async () => ({
  ok: true,
  assistantId: "ast-local",
}));
const getAppVersionInfoMock = mock(
  async (): ReturnType<typeof AppInfo.getAppVersionInfo> => null,
);
const requestSignedDownloadUrlMock = mock(
  async (_bundleKey: string, _targetRuntimeVersion: string | undefined) =>
    BUNDLE_URL,
);
const importBundleToLocalMock = mock(
  async (_local: LockfileAssistant, _bundleUrl: string) => {},
);
const setActiveLockfileAssistantMock = mock(async (_id: string) => {});
const retireAssistantMock = mock(
  async (
    _queryClient: QueryClient,
    _id: string,
  ): ReturnType<typeof RetireService.retireAssistant> => ({
    ok: true,
    nextRoute: "/assistant",
  }),
);

/** Stands in for exports the platform → local flow never reaches. */
const notReached = (() => {
  throw new Error("not reached by the platform → local flow");
}) as never;

mock.module(
  "./teleport-backup",
  (): Partial<typeof TeleportBackup> => ({
    ensureSourceBackup: ensureSourceBackupMock,
  }),
);
mock.module(
  "./managed-export",
  (): Partial<typeof ManagedExport> => ({
    exportManagedBundle: exportManagedBundleMock,
  }),
);
mock.module(
  "./platform-migration-client",
  (): Partial<typeof PlatformMigrationClient> => ({
    requestSignedDownloadUrl: requestSignedDownloadUrlMock,
    importFromGcs: notReached,
    pollJobStatus: notReached,
    requestSignedUploadUrl: notReached,
    uploadToSignedUrl: notReached,
  }),
);
mock.module(
  "./local-import",
  (): Partial<typeof LocalImport> => ({
    importBundleToLocal: importBundleToLocalMock,
  }),
);
mock.module(
  "./teleport-gateway-client",
  (): Partial<typeof GatewayClient> => ({ exportLocalBundle: notReached }),
);
mock.module(
  "./teleport-successor",
  (): Partial<typeof TeleportSuccessor> => ({
    resolveTeleportSuccessorId: notReached,
  }),
);
mock.module(
  "@/lib/local-mode",
  (): Partial<typeof LocalMode> => ({
    getSelectedAssistant: () => SOURCE,
    getLocalAssistants: () => [localEntry],
    loadLockfile: async () => ({
      assistants: [SOURCE, localEntry],
      activeAssistant: SOURCE.assistantId,
    }),
    setActiveLockfileAssistant: setActiveLockfileAssistantMock,
    getPlatformRuntimeUrl: notReached,
    saveLockfileAssistant: notReached,
  }),
);
mock.module(
  "@/runtime/local-mode-host",
  (): Partial<typeof LocalModeHost> => ({
    hatchLocalAssistant: hatchLocalAssistantMock,
  }),
);
mock.module(
  "@/runtime/app-info",
  (): Partial<typeof AppInfo> => ({
    getAppVersionInfo: getAppVersionInfoMock,
  }),
);
mock.module(
  "@/assistant/retire-service",
  (): Partial<typeof RetireService> => ({
    retireAssistant: retireAssistantMock,
  }),
);
mock.module(
  "@/lib/sentry/capture-error",
  (): Partial<typeof CaptureError> => ({
    captureError: () => {},
  }),
);
mock.module(
  "@/assistant/api",
  (): Partial<typeof AssistantApi> => ({ hatchAssistant: notReached }),
);
mock.module(
  "@/lib/local-platform-identity",
  (): Partial<typeof LocalPlatformIdentity> => ({
    bootstrapLocalAssistantPlatformIdentity: notReached,
  }),
);
mock.module(
  "@/generated/api/sdk.gen",
  (): Partial<typeof Sdk> => ({
    assistantsList: notReached,
    assistantsOperationalStatusDetailRead: notReached,
  }),
);
mock.module(
  "@/stores/auth-store",
  (): Partial<typeof AuthStore> => ({ useAuthStore: notReached }),
);
mock.module(
  "@/stores/organization-store",
  (): Partial<typeof OrganizationStore> => ({
    getActiveOrganizationIdForRequests: notReached,
    useOrganizationStore: notReached,
  }),
);

const { useTeleport } = await import("./use-teleport");
const { TeleportError } = await import("./teleport-types");

function renderTeleport() {
  const queryClient = new QueryClient();
  const phases: TeleportPhase[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  const rendered = renderHook(
    () => {
      const controller = useTeleport();
      phases.push(controller.phase);
      return controller;
    },
    { wrapper },
  );
  const steps = () =>
    phases.flatMap((phase) =>
      phase.kind === "transferring" ? [phase.step] : [],
    );
  return { ...rendered, queryClient, steps };
}

async function runTeleport() {
  const view = renderTeleport();
  expect(view.result.current.destination).toBe("local");
  act(() => view.result.current.confirm());
  await waitFor(() =>
    expect(["verifying", "failed"]).toContain(view.result.current.phase.kind),
  );
  return view;
}

beforeEach(() => {
  localEntry = {
    assistantId: "ast-local",
    cloud: "local",
    resources: { runtimeVersion: "1.2.3" },
  } as unknown as LockfileAssistant;
  for (const m of [
    ensureSourceBackupMock,
    exportManagedBundleMock,
    hatchLocalAssistantMock,
    getAppVersionInfoMock,
    requestSignedDownloadUrlMock,
    importBundleToLocalMock,
    setActiveLockfileAssistantMock,
    retireAssistantMock,
  ]) {
    m.mockClear();
  }
  importBundleToLocalMock.mockResolvedValue(undefined);
  requestSignedDownloadUrlMock.mockResolvedValue(BUNDLE_URL);
});

afterEach(() => {
  cleanup();
});

describe("useTeleport platform → local", () => {
  test("has the local runtime import the bundle from its signed URL", async () => {
    // Hold the import open long enough for its step to render.
    importBundleToLocalMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );

    const view = await runTeleport();

    expect(view.result.current.phase).toEqual({ kind: "verifying" });
    expect(requestSignedDownloadUrlMock.mock.calls).toEqual([
      [BUNDLE_KEY, "1.2.3"],
    ]);
    expect(importBundleToLocalMock.mock.calls).toEqual([
      [localEntry, BUNDLE_URL],
    ]);
    expect(view.steps().at(-1)).toBe("Importing data...");
    // The source stays active until the user confirms the switch.
    expect(setActiveLockfileAssistantMock.mock.calls.at(-1)).toEqual([
      "ast-managed",
    ]);
    expect(retireAssistantMock).not.toHaveBeenCalled();
  });

  test("retires the fresh local and restores the source when the import fails", async () => {
    importBundleToLocalMock.mockRejectedValue(
      new TeleportError("import_failed", "Bundle exceeds the 16 GiB limit"),
    );

    const view = await runTeleport();

    expect(view.result.current.phase).toEqual({
      kind: "failed",
      error: "Teleport failed: Bundle exceeds the 16 GiB limit",
    });
    await waitFor(() =>
      expect(retireAssistantMock.mock.calls).toEqual([
        [view.queryClient, "ast-local"],
      ]),
    );
    expect(setActiveLockfileAssistantMock.mock.calls.at(-1)).toEqual([
      "ast-managed",
    ]);
  });

  test("stops before the import when the target rejects the bundle version", async () => {
    requestSignedDownloadUrlMock.mockRejectedValue(
      new TeleportError(
        "version_mismatch",
        "Cannot import: bundle requires runtime 9.0.0+",
      ),
    );

    const view = await runTeleport();

    expect(view.result.current.phase).toEqual({
      kind: "failed",
      error: "Teleport failed: Cannot import: bundle requires runtime 9.0.0+",
    });
    expect(importBundleToLocalMock).not.toHaveBeenCalled();
    await waitFor(() => expect(retireAssistantMock).toHaveBeenCalledTimes(1));
  });

  test("stops before requesting a URL when the local runtime version is unknown", async () => {
    localEntry = {
      assistantId: "ast-local",
      cloud: "local",
    } as unknown as LockfileAssistant;

    const view = await runTeleport();

    expect(view.result.current.phase.kind).toBe("failed");
    expect(requestSignedDownloadUrlMock).not.toHaveBeenCalled();
    expect(importBundleToLocalMock).not.toHaveBeenCalled();
  });
});
