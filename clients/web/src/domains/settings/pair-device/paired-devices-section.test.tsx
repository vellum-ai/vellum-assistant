import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { create } from "zustand";

import type {
  LocalListDevicesResult,
  LocalPairedDeviceRecord,
  LocalRevokeDeviceResult,
} from "@/runtime/local-mode-host";

import { createTimerHarness } from "./pair-device-test-helpers";

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

// Reactive selection slice the hook subscribes to; tests flip it (alongside
// `selectedAssistantId`) to simulate a switch while the section stays mounted.
const selectionStore = create<{ selectedAssistantId: string | null }>(() => ({
  selectedAssistantId: "self",
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    selectedAssistantId: () => selectionStore((s) => s.selectedAssistantId),
  };
  return { useResolvedAssistantsStore: store };
});

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

function setListResult(result: LocalListDevicesResult) {
  listImpl = async () => result;
}

async function renderExpanded(devices: LocalPairedDeviceRecord[]) {
  setListResult({ ok: true, devices });
  render(<PairedDevicesSection />);
  // The list fetch is microtask-only; an awaited act drains it without timers.
  await act(async () => {});
  fireEvent.click(
    screen.getByRole("button", { name: `Paired devices (${devices.length})` }),
  );
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
  selectionStore.setState({ selectedAssistantId: "self" });
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
    setListResult({ ok: false, error: "unavailable" });
    const { container } = render(<PairedDevicesSection />);
    await waitFor(() => expect(listCalls.length).toBe(1));
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when no devices are paired", async () => {
    setListResult({ ok: true, devices: [] });
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
    // Drain the revoke and refetch kickoff; the refetch promise stays pending.
    await act(async () => {
      clickConfirm();
    });
    expect(listCalls.length).toBe(2);

    // Refetch in flight: the section (and its expanded rows) stays mounted.
    expect(screen.getByText("Ios")).toBeTruthy();
    expect(screen.getByText("Android")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Paired devices (2)" }),
    ).toBeTruthy();

    await act(async () => {
      resolveRefetch({
        ok: true,
        devices: [device({ hashedDeviceId: HASH_B, platform: "android" })],
      });
    });
    expect(screen.queryByText("Ios")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Paired devices (1)" }),
    ).toBeTruthy();
  });

  test("revokes against the assistant the rendered list was fetched for, not the current selection", async () => {
    await renderExpanded([device()]);

    // The fetch-time selection read moves before the reactive slice
    // republishes (only the raw read flips here, not `selectionStore`); the
    // rendered rows (and the confirm target) still belong to "self".
    selectedAssistantId = "other";
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    clickConfirm();

    await waitFor(() =>
      expect(revokeCalls).toEqual([
        { assistantId: "self", hashedDeviceId: HASH_A },
      ]),
    );
    // The post-revoke refresh re-reads the selection and fetches its list.
    await waitFor(() => expect(listCalls).toEqual(["self", "other"]));
  });

  test("a selection switch refetches for the new assistant and closes the confirm dialog", async () => {
    await renderExpanded([device()]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByText("Revoke this device?")).toBeTruthy();

    setListResult({
      ok: true,
      devices: [device({ hashedDeviceId: HASH_B, platform: "android" })],
    });
    await act(async () => {
      selectedAssistantId = "other";
      selectionStore.setState({ selectedAssistantId: "other" });
    });

    expect(listCalls).toEqual(["self", "other"]);
    expect(revokeCalls).toHaveLength(0);
    expect(screen.queryByText("Revoke this device?")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Paired devices (1)" }),
    ).toBeTruthy();
  });

  test("the host machine's own row is labeled with Revoke disabled; others stay revocable", async () => {
    await renderExpanded([
      device({ platform: "cli", isCurrentHost: true }),
      device({ hashedDeviceId: HASH_B, platform: "android" }),
    ]);

    expect(screen.getByText(/This machine/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", {
      name: "Revoke",
    }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.disabled).toBe(true);
    expect(buttons[0]!.getAttribute("title")).toContain(
      "lock the host out of the assistant",
    );
    expect(buttons[1]!.disabled).toBe(false);

    // The disabled host row never opens the confirm dialog.
    fireEvent.click(buttons[0]!);
    expect(screen.queryByText("Revoke this device?")).toBeNull();

    // The non-host row still runs the confirm-then-revoke flow.
    fireEvent.click(buttons[1]!);
    expect(screen.getByText("Revoke this device?")).toBeTruthy();
    clickConfirm();
    await waitFor(() =>
      expect(revokeCalls).toEqual([
        { assistantId: "self", hashedDeviceId: HASH_B },
      ]),
    );
  });

  test("polls while a pairing code is live and refreshes once more when it ends", async () => {
    const timerHarness = createTimerHarness();
    const livePolls = () => timerHarness.timers.filter((t) => !t.cleared);
    timerHarness.install();

    try {
      setListResult({ ok: true, devices: [device()] });
      const { rerender } = render(<PairedDevicesSection pollWhilePairing />);
      await act(async () => {});
      expect(listCalls).toEqual(["self"]);
      expect(livePolls()).toHaveLength(1);

      // Another device claims the live code; the next tick surfaces it.
      setListResult({
        ok: true,
        devices: [
          device(),
          device({ hashedDeviceId: HASH_B, platform: "android" }),
        ],
      });
      await act(async () => {
        for (const poll of livePolls()) {
          poll.handler();
        }
      });
      expect(listCalls).toEqual(["self", "self"]);
      expect(
        screen.getByRole("button", { name: "Paired devices (2)" }),
      ).toBeTruthy();

      // Code consumed/expired: the interval is cleared and one final
      // refresh catches a claim in the last window.
      rerender(<PairedDevicesSection pollWhilePairing={false} />);
      await act(async () => {});
      expect(livePolls()).toHaveLength(0);
      expect(listCalls).toEqual(["self", "self", "self"]);
    } finally {
      timerHarness.restore();
    }
  });

  test("does not poll without a live pairing code", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();
    try {
      await renderExpanded([device()]);
      expect(timerHarness.timers).toHaveLength(0);
      expect(listCalls).toEqual(["self"]);
    } finally {
      timerHarness.restore();
    }
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
