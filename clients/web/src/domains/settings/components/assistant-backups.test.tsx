import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let platformHosted = true;
let exportFails = false;
const calls: string[] = [];
let toastErrors: string[] = [];

mock.module("@/assistant/api", () => ({
  listAssistantBackups: async () => ({ ok: true, status: 200, data: [] }),
  createAssistantBackup: async () => ({ ok: true, status: 201, data: {} }),
  restoreAssistantBackup: async () => ({ ok: true, status: 200, data: {} }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  useActiveAssistantIsPlatformHosted: () => platformHosted,
}));

mock.module("@/domains/settings/teleport/managed-export", () => ({
  exportBundleFilename: (label: string) => `${label}-2026-10-02.vbundle`,
  exportManagedBundle: async (
    assistantId: string,
    { onStep }: { onStep?: (step: string) => void } = {},
  ) => {
    calls.push(`export:${assistantId}`);
    onStep?.("exporting");
    if (exportFails) {
      const { TeleportError } = await import(
        "@/domains/settings/teleport/teleport-types"
      );
      throw new TeleportError("export_failed", "Export failed (HTTP 500).");
    }
    return { bundleKey: "uploads/org-abc/bundle.vbundle", runtimeVersion: "1.2.3" };
  },
}));

mock.module("@/domains/settings/teleport/platform-migration-client", () => ({
  requestSignedDownloadUrl: async (
    bundleKey: string,
    targetRuntimeVersion: string | undefined,
    downloadFilename?: string,
  ) => {
    calls.push(
      `download-url:${bundleKey}:${targetRuntimeVersion}:${downloadFilename}`,
    );
    return "https://storage.example.com/download";
  },
}));

mock.module("@/runtime/native-file", () => ({
  saveFile: async (source: string, filename: string) => {
    calls.push(`save:${source}:${filename}`);
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

async function confirmExport() {
  fireEvent.click(await screen.findByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  within(dialog).getByText(/credentials aren't included/i);
  fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
}

describe("AssistantBackups export", () => {
  beforeEach(() => {
    platformHosted = true;
    exportFails = false;
    calls.length = 0;
    toastErrors = [];
  });
  afterEach(() => cleanup());

  test("exports, then saves the bundle from a named signed download URL", async () => {
    render(<AssistantBackups assistantId="ast-1" />);

    await confirmExport();

    await waitFor(() =>
      expect(calls).toEqual([
        "export:ast-1",
        "download-url:uploads/org-abc/bundle.vbundle:1.2.3:ast-1-2026-10-02.vbundle",
        "save:https://storage.example.com/download:ast-1-2026-10-02.vbundle",
      ]),
    );
    expect(toastErrors).toEqual([]);
  });

  test("a failed export toasts and leaves the button ready", async () => {
    exportFails = true;
    render(<AssistantBackups assistantId="ast-1" />);

    await confirmExport();

    await waitFor(() =>
      expect(toastErrors).toEqual(["Failed to export the assistant."]),
    );
    expect(calls).toEqual(["export:ast-1"]);
    expect(
      (screen.getByRole("button", { name: "Export" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("cancelling the confirmation starts no export", async () => {
    render(<AssistantBackups assistantId="ast-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([]);
  });

  test("a self-hosted assistant gets no Export button", async () => {
    platformHosted = false;
    render(<AssistantBackups assistantId="ast-1" />);

    await screen.findByRole("button", { name: "Create Backup" });
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });
});
