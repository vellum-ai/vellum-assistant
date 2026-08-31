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
let revokeResult: LocalRevokeDeviceResult | Promise<LocalRevokeDeviceResult> = {
  ok: true,
};
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

/** The pairing poll's arm delay, telling it apart from the other intervals. */
const POLL_INTERVAL_MS = 5_000;

/** The activity refresh's arm delay; the relative-age tick's 30s is neither. */
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

const HASH_A = "aaaabbbbccccdddd0000111122223333";
const HASH_B = "eeeeffff00001111aaaabbbbccccdddd";
const HASH_C = "1111222233334444aaaabbbbccccdddd";

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
  const result = render(<PairedDevicesSection />);
  // The list fetch is microtask-only; an awaited act drains it without timers.
  await act(async () => {});
  fireEvent.click(deviceListTrigger(devices.length));
  return result;
}

/** The accordion trigger, which is also the expand/collapse toggle. */
function deviceListTrigger(count: number): HTMLElement {
  return screen.getByRole("button", { name: `Paired devices (${count})` });
}

function clickConfirm() {
  fireEvent.click(
    document.querySelector<HTMLButtonElement>("[data-confirm-dialog-confirm]")!,
  );
}

/** Timers armed at `delay` and still live, so cleared arms drop out. */
function liveTimers(
  harness: ReturnType<typeof createTimerHarness>,
  delay: number,
) {
  return harness.timers.filter(
    (timer) => !timer.cleared && timer.delay === delay,
  );
}

/** Rendered rows in order, read off the full hash each row's chip carries. */
function renderedDeviceOrder(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLSpanElement>("span[title]"),
  ).map((span) => span.title);
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
      screen.getByText(new RegExp(`Ios \\(${HASH_A.slice(0, 12)}\\)`)),
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

  test("a device with a client-reported name shows it verbatim, hash hidden but kept in the title", async () => {
    await renderExpanded([device({ clientReportedName: "Alice's Laptop" })]);

    const name = screen.getByText("Alice's Laptop");
    expect(name.getAttribute("title")).toBe(HASH_A);
    expect(screen.queryByText(HASH_A.slice(0, 12))).toBeNull();
  });

  test("a device with only a pairing User-Agent shows a composed browser and OS label", async () => {
    await renderExpanded([
      device({
        pairingUserAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36",
      }),
    ]);

    const name = screen.getByText("Chrome on macOS");
    expect(name.getAttribute("title")).toBe(HASH_A);
    expect(screen.queryByText(HASH_A.slice(0, 12))).toBeNull();
  });

  test("a device with neither a reported name nor a User-Agent still renders the platform label with the hash inline", async () => {
    await renderExpanded([device()]);

    expect(screen.getByText("Ios")).toBeTruthy();
    const shortA = screen.getByText(HASH_A.slice(0, 12));
    expect(shortA.getAttribute("title")).toBe(HASH_A);
  });

  test("the revoke confirmation leads with a client-reported name", async () => {
    await renderExpanded([device({ clientReportedName: "Alice's Laptop" })]);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(
      screen.getByText(
        new RegExp(`Alice's Laptop \\(${HASH_A.slice(0, 12)}\\)`),
      ),
    ).toBeTruthy();
  });

  test('a device self-reporting as "This machine" cannot spoof the host marker or disable its own Revoke', async () => {
    await renderExpanded([
      device({ clientReportedName: "This machine", isCurrentHost: false }),
    ]);

    // Exactly one occurrence: the reported name, not a second host marker.
    expect(screen.getAllByText("This machine")).toHaveLength(1);
    const revokeButton = screen.getByRole("button", {
      name: "Revoke",
    }) as HTMLButtonElement;
    expect(revokeButton.disabled).toBe(false);

    fireEvent.click(revokeButton);
    expect(screen.getByText("Revoke this device?")).toBeTruthy();
  });

  test("polls while a pairing code is live and refreshes once more when it ends", async () => {
    const timerHarness = createTimerHarness();
    const livePolls = () => liveTimers(timerHarness, POLL_INTERVAL_MS);
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
      expect(liveTimers(timerHarness, POLL_INTERVAL_MS)).toHaveLength(0);
      // The slow activity refresh is the only list timer without a live code.
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);
      expect(listCalls).toEqual(["self"]);
    } finally {
      timerHarness.restore();
    }
  });

  test("refreshes on the activity interval so the label tracks a fresh sample", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      await renderExpanded([
        device({ lastUsedAt: Date.now() - 3 * 60 * 60 * 1000 }),
      ]);
      expect(
        screen.getByText(/^Paired \d.+ · Last used 3 hours ago$/),
      ).toBeTruthy();
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);

      // The device never stopped talking to the gateway; the refresh
      // resamples `lastUsedAt` instead of aging the one taken at mount.
      setListResult({
        ok: true,
        devices: [device({ lastUsedAt: Date.now() })],
      });
      await act(async () => {
        for (const refreshTimer of liveTimers(
          timerHarness,
          ACTIVITY_REFRESH_INTERVAL_MS,
        )) {
          refreshTimer.handler();
        }
      });

      expect(listCalls).toEqual(["self", "self"]);
      expect(screen.getByText(/^Paired \d.+ · Active now$/)).toBeTruthy();
    } finally {
      timerHarness.restore();
    }
  });

  test("stands the activity refresh down while the pairing poll runs", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      setListResult({ ok: true, devices: [device()] });
      const { rerender } = render(<PairedDevicesSection pollWhilePairing />);
      await act(async () => {});
      fireEvent.click(deviceListTrigger(1));
      expect(liveTimers(timerHarness, POLL_INTERVAL_MS)).toHaveLength(1);
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(0);

      // A tick of the live code's poll is the only fetch it produces.
      await act(async () => {
        for (const poll of liveTimers(timerHarness, POLL_INTERVAL_MS)) {
          poll.handler();
        }
      });
      expect(listCalls).toEqual(["self", "self"]);

      // Code consumed/expired: the poll clears and the slow refresh takes over.
      rerender(<PairedDevicesSection pollWhilePairing={false} />);
      await act(async () => {});
      expect(liveTimers(timerHarness, POLL_INTERVAL_MS)).toHaveLength(0);
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);
      expect(listCalls).toEqual(["self", "self", "self"]);
    } finally {
      timerHarness.restore();
    }
  });

  test("pauses the activity refresh while a revoke is in flight", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      await renderExpanded([device()]);
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);

      let resolveRevoke!: (result: LocalRevokeDeviceResult) => void;
      revokeResult = new Promise<LocalRevokeDeviceResult>((resolve) => {
        resolveRevoke = resolve;
      });
      fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
      await act(async () => {
        clickConfirm();
      });
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(0);

      await act(async () => {
        resolveRevoke({ ok: true });
      });
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);
    } finally {
      timerHarness.restore();
    }
  });

  test("clears the activity refresh on unmount", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      const { unmount } = await renderExpanded([device()]);
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);

      unmount();

      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(0);
    } finally {
      timerHarness.restore();
    }
  });

  test("leaves the activity refresh disarmed while the list is collapsed", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      setListResult({ ok: true, devices: [device()] });
      render(<PairedDevicesSection />);
      await act(async () => {});

      // The trigger renders, but the rows behind it do not: refreshing them
      // would spawn a host subprocess every minute for a label nobody can read.
      expect(deviceListTrigger(1)).toBeTruthy();
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(0);
      expect(listCalls).toEqual(["self"]);
    } finally {
      timerHarness.restore();
    }
  });

  test("arms the activity refresh on expand and clears it on collapse", async () => {
    const timerHarness = createTimerHarness();
    timerHarness.install();

    try {
      setListResult({ ok: true, devices: [device()] });
      render(<PairedDevicesSection />);
      await act(async () => {});

      fireEvent.click(deviceListTrigger(1));
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(1);

      fireEvent.click(deviceListTrigger(1));
      expect(
        liveTimers(timerHarness, ACTIVITY_REFRESH_INTERVAL_MS),
      ).toHaveLength(0);
      expect(listCalls).toEqual(["self"]);
    } finally {
      timerHarness.restore();
    }
  });

  test("a device seen inside the activity window reads Active now", async () => {
    await renderExpanded([device({ lastUsedAt: Date.now() - 2 * 60 * 1000 })]);

    expect(screen.getByText(/^Paired \d.+ · Active now$/)).toBeTruthy();
  });

  test("an older device reads a relative last-used label", async () => {
    await renderExpanded([
      device({ lastUsedAt: Date.now() - 3 * 60 * 60 * 1000 }),
    ]);

    expect(
      screen.getByText(/^Paired \d.+ · Last used 3 hours ago$/),
    ).toBeTruthy();
    expect(screen.queryByText(/Active now/)).toBeNull();
  });

  test("a device never seen drops the last-used clause entirely", async () => {
    await renderExpanded([device({ lastUsedAt: null })]);

    expect(screen.getByText(/^Paired \d\S+$/)).toBeTruthy();
    expect(screen.queryByText(/Last used/)).toBeNull();
    expect(document.body.textContent).not.toContain("unknown");
  });

  test("orders devices by most recent activity, never-seen ones last", async () => {
    await renderExpanded([
      device({ hashedDeviceId: HASH_A, lastUsedAt: null }),
      device({
        hashedDeviceId: HASH_B,
        lastUsedAt: Date.parse("2026-08-10T12:00:00Z"),
      }),
      device({
        hashedDeviceId: HASH_C,
        lastUsedAt: Date.parse("2026-08-20T12:00:00Z"),
      }),
    ]);

    expect(renderedDeviceOrder()).toEqual([HASH_C, HASH_B, HASH_A]);
  });

  test("revoking targets the clicked row once the list is reordered", async () => {
    await renderExpanded([
      device({
        hashedDeviceId: HASH_A,
        platform: "ios",
        lastUsedAt: Date.parse("2026-08-10T12:00:00Z"),
      }),
      device({
        hashedDeviceId: HASH_B,
        platform: "android",
        lastUsedAt: Date.parse("2026-08-20T12:00:00Z"),
      }),
    ]);

    // The android device is the more recently used one, so it sorts first.
    expect(renderedDeviceOrder()).toEqual([HASH_B, HASH_A]);
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);

    expect(
      screen.getByText(new RegExp(`Android \\(${HASH_B.slice(0, 12)}\\)`)),
    ).toBeTruthy();
    clickConfirm();

    await waitFor(() =>
      expect(revokeCalls).toEqual([
        { assistantId: "self", hashedDeviceId: HASH_B },
      ]),
    );
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
