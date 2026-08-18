import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type {
  LocalListDevicesResult,
  LocalPairedDeviceRecord,
  LocalRevokeDeviceResult,
} from "@/runtime/local-mode-host";

let listImpl: (assistantId: string) => Promise<LocalListDevicesResult>;
let listCalls: string[] = [];
let revokeResult: LocalRevokeDeviceResult = { ok: true };
let revokeCalls: Array<{ assistantId: string; hashedDeviceId: string }> = [];
let selectedAssistantId = "self";

mock.module(
  "@/runtime/local-mode-host",
  (): Partial<typeof import("@/runtime/local-mode-host")> => ({
    listPairedDevicesHost: async (assistantId: string) => {
      listCalls.push(assistantId);
      return listImpl(assistantId);
    },
    revokePairedDeviceHost: async (
      assistantId: string,
      hashedDeviceId: string,
    ) => {
      revokeCalls.push({ assistantId, hashedDeviceId });
      return revokeResult;
    },
  }),
);

mock.module(
  "@/lib/local-mode",
  (): Partial<typeof import("@/lib/local-mode")> => ({
    getSelectedAssistant: () => ({
      assistantId: selectedAssistantId,
      cloud: "local",
    }),
    // Sibling test files in this suite mock the same module and share a
    // process; keep the export their modules import so relinking succeeds.
    getLocalGatewayUrl: () => undefined,
  }),
);

const { PairedDevicesSection } = await import("./paired-devices-section");

const HASH_A = "aaaabbbbccccdddd0000111122223333";
const HASH_B = "eeeeffff00001111aaaabbbbccccdddd";

function device(
  overrides: Partial<LocalPairedDeviceRecord> = {},
): LocalPairedDeviceRecord {
  return {
    hashedDeviceId: HASH_A,
    platform: "ios",
    issuedAt: Date.parse("2026-08-01T12:00:00Z"),
    expiresAt: null,
    lastUsedAt: Date.parse("2026-08-15T12:00:00Z"),
    ...overrides,
  };
}

/** Queue list responses; later calls replay the last entry. */
function queueListResults(...results: LocalListDevicesResult[]) {
  let index = 0;
  listImpl = async () => {
    const result = results[Math.min(index, results.length - 1)]!;
    index += 1;
    return result;
  };
}

async function renderExpanded(devices: LocalPairedDeviceRecord[]) {
  queueListResults({ ok: true, devices }, { ok: true, devices });
  render(<PairedDevicesSection />);
  const trigger = await screen.findByRole("button", {
    name: `Paired devices (${devices.length})`,
  });
  fireEvent.click(trigger);
}

function clickConfirm() {
  fireEvent.click(
    document.querySelector<HTMLButtonElement>("[data-confirm-dialog-confirm]")!,
  );
}

beforeEach(() => {
  listImpl = async () => ({ ok: false, error: "unset" });
  listCalls = [];
  revokeResult = { ok: true };
  revokeCalls = [];
  selectedAssistantId = "self";
});

afterEach(() => {
  cleanup();
});

describe("PairedDevicesSection", () => {
  test("renders nothing while the list is loading", () => {
    listImpl = () => new Promise(() => {});
    const { container } = render(<PairedDevicesSection />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when the host refuses the list", async () => {
    queueListResults({ ok: false, error: "unavailable" });
    const { container } = render(<PairedDevicesSection />);
    await waitFor(() => expect(listCalls.length).toBe(1));
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when no devices are paired", async () => {
    queueListResults({ ok: true, devices: [] });
    const { container } = render(<PairedDevicesSection />);
    await waitFor(() => expect(listCalls.length).toBe(1));
    expect(container.firstChild).toBeNull();
  });

  test("shows the count in the trigger and device rows when expanded", async () => {
    await renderExpanded([
      device(),
      device({ hashedDeviceId: HASH_B, platform: "android" }),
    ]);

    expect(listCalls).toEqual(["self"]);
    expect(screen.getByText("Ios")).toBeTruthy();
    expect(screen.getByText("Android")).toBeTruthy();
    const shortA = screen.getByText(HASH_A.slice(0, 12));
    expect(shortA.getAttribute("title")).toBe(HASH_A);
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
  });

  test("clicking Revoke opens the confirmation naming the device", async () => {
    await renderExpanded([device()]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(screen.getByText("Revoke this device?")).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`Ios device ${HASH_A.slice(0, 12)}`)),
    ).toBeTruthy();
    expect(revokeCalls).toHaveLength(0);
  });

  test("confirming revokes the device and refetches the list", async () => {
    await renderExpanded([device()]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    clickConfirm();

    await waitFor(() => expect(listCalls.length).toBe(2));
    expect(revokeCalls).toEqual([
      { assistantId: "self", hashedDeviceId: HASH_A },
    ]);
    await waitFor(() =>
      expect(screen.queryByText("Revoke this device?")).toBeNull(),
    );
  });

  test("keeps the previous list rendered while the post-revoke refetch is in flight", async () => {
    await renderExpanded([
      device(),
      device({ hashedDeviceId: HASH_B, platform: "android" }),
    ]);

    let resolveRefetch!: (result: LocalListDevicesResult) => void;
    listImpl = () =>
      new Promise<LocalListDevicesResult>((resolve) => {
        resolveRefetch = resolve;
      });

    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    clickConfirm();
    await waitFor(() => expect(listCalls.length).toBe(2));

    // Refetch in flight: the section (and its expanded rows) stays mounted.
    expect(screen.getByText("Ios")).toBeTruthy();
    expect(screen.getByText("Android")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Paired devices (2)" }),
    ).toBeTruthy();

    resolveRefetch({
      ok: true,
      devices: [device({ hashedDeviceId: HASH_B, platform: "android" })],
    });
    await waitFor(() => expect(screen.queryByText("Ios")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Paired devices (1)" }),
    ).toBeTruthy();
  });

  test("revokes against the currently selected assistant id read at call time", async () => {
    await renderExpanded([device()]);

    selectedAssistantId = "other";
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    clickConfirm();

    await waitFor(() =>
      expect(revokeCalls).toEqual([
        { assistantId: "other", hashedDeviceId: HASH_A },
      ]),
    );
    await waitFor(() => expect(listCalls).toEqual(["self", "other"]));
  });

  test("a failed revoke keeps the dialog open with the error", async () => {
    revokeResult = { ok: false, error: "Gateway is unreachable" };
    await renderExpanded([device()]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    clickConfirm();

    await waitFor(() =>
      expect(screen.getByText("Gateway is unreachable")).toBeTruthy(),
    );
    expect(screen.getByText("Revoke this device?")).toBeTruthy();
    expect(listCalls).toHaveLength(1);
  });
});
