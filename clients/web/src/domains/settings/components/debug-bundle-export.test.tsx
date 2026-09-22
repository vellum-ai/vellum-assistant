import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const LOCAL = { assistantId: "local-1", cloud: "local" } as const;
let selected: typeof LOCAL | null = LOCAL;
let gatewayPath: string | null = "/assistant/__gateway/7830";
const calls: string[] = [];
let exportFails = false;
let toastErrors: string[] = [];
let supportsProfile = true;

mock.module("@/lib/backwards-compat/use-supports-debug-export-profile", () => ({
  MIN_VERSION: "0.12.3",
  useSupportsDebugExportProfile: () => supportsProfile,
}));

mock.module("@/lib/local-mode", () => ({
  getSelectedAssistant: () => selected,
  getLocalGatewayUrl: () => gatewayPath,
}));

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsDebugBundleUploadUrlCreate: async ({
    path,
  }: {
    path: { id: string };
  }) => {
    calls.push(`platform:${path.id}`);
    return { data: { url: "https://bucket/signed", bundle_key: "k" } };
  },
}));

mock.module("@/domains/settings/teleport/teleport-gateway-client", () => ({
  exportLocalDebugBundle: async (
    assistant: { assistantId: string },
    uploadUrl: string,
  ) => {
    calls.push(`export:${assistant.assistantId}:${uploadUrl}`);
    if (exportFails) {
      throw new Error("gateway socket missing");
    }
    return "job-1";
  },
  pollLocalExportJob: async (_a: unknown, jobId: string) => {
    calls.push(`poll:${jobId}`);
    return "complete";
  },
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

import { DebugBundleExport } from "@/domains/settings/components/debug-bundle-export";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

function renderRow() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DebugBundleExport assistantId="asst-1" pollIntervalMs={10} />
    </QueryClientProvider>,
  );
}

describe("DebugBundleExport", () => {
  beforeEach(() => {
    selected = LOCAL;
    gatewayPath = "/assistant/__gateway/7830";
    calls.length = 0;
    exportFails = false;
    toastErrors = [];
    supportsProfile = true;
  });
  afterEach(() => cleanup());

  test("asks the platform for the URL, then the daemon for the export, then waits for the job", async () => {
    renderRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Export debug bundle" }),
    );

    await screen.findByText(/sent to vellum at/i);
    expect(calls).toEqual([
      "platform:asst-1",
      "export:local-1:https://bucket/signed",
      "poll:job-1",
    ]);
  });

  test("a failed export says why and leaves the button ready", async () => {
    exportFails = true;
    renderRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Export debug bundle" }),
    );

    await waitFor(() => expect(toastErrors).toHaveLength(1));
    expect(toastErrors[0]).toContain("gateway socket missing");
    expect(screen.queryByText(/sent to vellum at/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Export debug bundle" }),
    ).toBeTruthy();
  });

  test("a daemon older than the debug profile gets an update note, never the button", () => {
    // Such a daemon would strip `profile` and upload a bundle with
    // credentials to the staff URL.
    supportsProfile = false;
    renderRow();
    expect(screen.queryByRole("button")).toBeNull();
    screen.getByText(/update the assistant to 0\.12\.3/i);
    expect(calls).toEqual([]);
  });

  test("without a local daemon it points at the desktop app instead of a button", () => {
    gatewayPath = null;
    renderRow();
    expect(screen.queryByRole("button")).toBeNull();
    screen.getByText(/export from the vellum desktop app/i);
  });
});
