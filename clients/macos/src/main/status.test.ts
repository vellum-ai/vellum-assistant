import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

const sentMessages: Array<{ channel: string; payload: unknown }> = [];
mock.module("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentMessages.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// Capture the channel + schema + handler that `installStatusIpc` registers,
// without dragging in the real `ipcMain` / sender-origin guard (that guard is
// covered by `ipc.test.ts`). The captured schema is exercised directly so we
// assert the payload contract the renderer must satisfy.
type OnRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => void;
};
const registrations: OnRegistration[] = [];
const onMock = mock(
  (channel: string, schema: z.ZodType<unknown[]>, fn: (args: unknown[]) => void) => {
    registrations.push({ channel, schema, fn });
  },
);

type HandleRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => unknown;
};
const handleRegistrations: HandleRegistration[] = [];
const handleMock = mock(
  (channel: string, schema: z.ZodType<unknown[]>, fn: (args: unknown[]) => unknown) => {
    handleRegistrations.push({ channel, schema, fn });
  },
);
mock.module("./ipc", () => ({ on: onMock, handle: handleMock }));

mock.module("./logger", () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

const {
  ASSISTANT_STATUSES,
  CONNECTIVITY_STATES,
  PULSE_FRAME_COUNT,
  PULSE_MAX_OPACITY,
  PULSE_MIN_OPACITY,
  getConnectivity,
  getStatus,
  installConnectivityIpc,
  installStatusIpc,
  onConnectivityChange,
  onStatusChange,
  pulseOpacityFrames,
  setBackendReachable,
  setConnectivity,
  setDeviceOnline,
  setStatus,
  shouldPulse,
  statusMenuTitle,
  __resetForTesting,
} = await import("./status");

beforeEach(() => {
  __resetForTesting();
  registrations.length = 0;
  handleRegistrations.length = 0;
  sentMessages.length = 0;
  onMock.mockClear();
  handleMock.mockClear();
});

describe("statusMenuTitle", () => {
  test("produces the header line for each status and defaults the assistant name", () => {
    expect(statusMenuTitle("idle")).toBe("Assistant is idle");
    expect(statusMenuTitle("thinking")).toBe("Assistant is thinking…");
    expect(statusMenuTitle("error")).toBe("Assistant encountered an error");
    expect(statusMenuTitle("disconnected")).toBe("Disconnected from Assistant");
    // The authFailed line must not point at a control the menu doesn't have
    // yet (there is no Re-pair item), so it states the failure generically.
    expect(statusMenuTitle("authFailed")).toBe(
      "Authentication failed — reconnect to continue",
    );
  });

  test("uses a single Unicode ellipsis for the thinking line, per the HIG", () => {
    // macOS Human Interface Guidelines call for the ellipsis character
    // (U+2026), not three periods, in status and in-progress text.
    // https://developer.apple.com/design/human-interface-guidelines/typography
    const thinking = statusMenuTitle("thinking");
    expect(thinking.endsWith("…")).toBe(true);
    expect(thinking).not.toContain("...");
  });

  test("interpolates a provided assistant name", () => {
    expect(statusMenuTitle("idle", "Ada")).toBe("Ada is idle");
    expect(statusMenuTitle("disconnected", "Ada")).toBe("Disconnected from Ada");
  });
});

describe("shouldPulse", () => {
  test("only thinking pulses", () => {
    expect(shouldPulse("thinking")).toBe(true);
    for (const status of ASSISTANT_STATUSES.filter((s) => s !== "thinking")) {
      expect(shouldPulse(status)).toBe(false);
    }
  });
});

describe("pulseOpacityFrames", () => {
  test("starts solid, dips to the minimum at the midpoint, and stays in range", () => {
    const frames = pulseOpacityFrames(PULSE_FRAME_COUNT);
    expect(frames).toHaveLength(PULSE_FRAME_COUNT);
    expect(frames[0]).toBeCloseTo(PULSE_MAX_OPACITY, 5);
    expect(frames[PULSE_FRAME_COUNT / 2]).toBeCloseTo(PULSE_MIN_OPACITY, 5);
    for (const opacity of frames) {
      expect(opacity).toBeGreaterThanOrEqual(PULSE_MIN_OPACITY - 1e-9);
      expect(opacity).toBeLessThanOrEqual(PULSE_MAX_OPACITY + 1e-9);
    }
  });

  test("is symmetric about the midpoint so the pulse eases evenly in and out", () => {
    const frames = pulseOpacityFrames(PULSE_FRAME_COUNT);
    for (let i = 1; i < PULSE_FRAME_COUNT / 2; i++) {
      expect(frames[i]).toBeCloseTo(frames[PULSE_FRAME_COUNT - i]!, 5);
    }
  });
});

describe("status state machine", () => {
  test("starts idle and reports the current status", () => {
    expect(getStatus()).toBe("idle");
    setStatus("error");
    expect(getStatus()).toBe("error");
  });

  test("notifies subscribers only on an actual change", () => {
    const seen: string[] = [];
    onStatusChange((status) => seen.push(status));

    setStatus("idle"); // no-op: already idle
    setStatus("thinking");
    setStatus("thinking"); // no-op: unchanged
    setStatus("disconnected");

    expect(seen).toEqual(["thinking", "disconnected"]);
  });

  test("unsubscribe stops further notifications", () => {
    const seen: string[] = [];
    const unsubscribe = onStatusChange((status) => seen.push(status));
    setStatus("thinking");
    unsubscribe();
    setStatus("error");
    expect(seen).toEqual(["thinking"]);
  });
});

describe("installStatusIpc", () => {
  test("registers the connection channel once, even across repeated calls", () => {
    installStatusIpc();
    installStatusIpc();
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.channel).toBe("vellum:status:connection");
  });

  test("the schema accepts every known status and rejects anything else", () => {
    installStatusIpc();
    const schema = registrations[0]!.schema;
    for (const status of ASSISTANT_STATUSES) {
      expect(schema.safeParse([status]).success).toBe(true);
    }
    expect(schema.safeParse(["bogus"]).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse(["idle", "extra"]).success).toBe(false);
  });

  test("a valid payload drives the status state machine", () => {
    installStatusIpc();
    const seen: string[] = [];
    onStatusChange((status) => seen.push(status));
    registrations[0]!.fn(["thinking"]);
    expect(getStatus()).toBe("thinking");
    expect(seen).toEqual(["thinking"]);
  });
});

// ---------------------------------------------------------------------------
// Connectivity state machine
// ---------------------------------------------------------------------------

describe("connectivity state machine", () => {
  test("starts online", () => {
    expect(getConnectivity()).toBe("online");
  });

  test("device-offline wins over backend-unreachable", () => {
    setBackendReachable(false);
    expect(getConnectivity()).toBe("backend-unreachable");
    setDeviceOnline(false);
    expect(getConnectivity()).toBe("device-offline");
  });

  test("recovering device online falls through to backend state", () => {
    setDeviceOnline(false);
    setBackendReachable(false);
    expect(getConnectivity()).toBe("device-offline");
    setDeviceOnline(true);
    expect(getConnectivity()).toBe("backend-unreachable");
    setBackendReachable(true);
    expect(getConnectivity()).toBe("online");
  });

  test("deduplicates — same state does not re-broadcast", () => {
    const seen: string[] = [];
    onConnectivityChange((s) => seen.push(s));
    setDeviceOnline(false);
    setDeviceOnline(false);
    expect(seen).toEqual(["device-offline"]);
  });

  test("broadcasts to all BrowserWindows on change", () => {
    setDeviceOnline(false);
    const msg = sentMessages.find(
      (m) => m.channel === "vellum:connectivity:state",
    );
    expect(msg).toBeDefined();
    expect(msg!.payload).toBe("device-offline");
  });

  test("setConnectivity directly updates state and notifies listeners", () => {
    const seen: string[] = [];
    onConnectivityChange((s) => seen.push(s));
    setConnectivity("backend-unreachable");
    expect(getConnectivity()).toBe("backend-unreachable");
    expect(seen).toEqual(["backend-unreachable"]);
  });

  test("unsubscribe stops further notifications", () => {
    const seen: string[] = [];
    const unsub = onConnectivityChange((s) => seen.push(s));
    setDeviceOnline(false);
    unsub();
    setDeviceOnline(true);
    expect(seen).toEqual(["device-offline"]);
  });
});

describe("installConnectivityIpc", () => {
  test("registers device and retry channels once", () => {
    installConnectivityIpc();
    installConnectivityIpc();
    const channels = registrations.map((r) => r.channel);
    expect(
      channels.filter((c) => c === "vellum:connectivity:device"),
    ).toHaveLength(1);
    const handled = handleRegistrations.map((r) => r.channel);
    expect(
      handled.filter((c) => c === "vellum:connectivity:retry"),
    ).toHaveLength(1);
  });

  test("device channel drives deviceOnline signal", () => {
    installConnectivityIpc();
    const deviceReg = registrations.find(
      (r) => r.channel === "vellum:connectivity:device",
    )!;
    deviceReg.fn([false]);
    expect(getConnectivity()).toBe("device-offline");
    deviceReg.fn([true]);
    expect(getConnectivity()).toBe("online");
  });

  test("retry runs the probe and returns the post-probe state", async () => {
    const onRetry = mock(() => Promise.resolve());
    installConnectivityIpc(onRetry);
    const retryReg = handleRegistrations.find(
      (r) => r.channel === "vellum:connectivity:retry",
    )!;
    setBackendReachable(false);
    expect(await retryReg.fn([])).toBe("backend-unreachable");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("retry rebroadcasts the current state even when unchanged", async () => {
    installConnectivityIpc();
    const retryReg = handleRegistrations.find(
      (r) => r.channel === "vellum:connectivity:retry",
    )!;
    // State is "online" and never transitions, so the change-gated broadcast
    // in setConnectivity stays silent — a desynced renderer depends on this
    // unconditional resend to recover.
    expect(await retryReg.fn([])).toBe("online");
    const msgs = sentMessages.filter(
      (m) => m.channel === "vellum:connectivity:state",
    );
    expect(msgs.map((m) => m.payload)).toEqual(["online"]);
  });

  test("registers the get channel for current state queries", () => {
    installConnectivityIpc();
    const getReg = handleRegistrations.find(
      (r) => r.channel === "vellum:connectivity:get",
    );
    expect(getReg).toBeDefined();
  });

  test("get channel returns the current connectivity state", () => {
    installConnectivityIpc();
    const getReg = handleRegistrations.find(
      (r) => r.channel === "vellum:connectivity:get",
    )!;
    expect(getReg.fn([])).toBe("online");
    setDeviceOnline(false);
    expect(getReg.fn([])).toBe("device-offline");
  });

  test("CONNECTIVITY_STATES contains the three expected values", () => {
    expect([...CONNECTIVITY_STATES]).toEqual([
      "online",
      "device-offline",
      "backend-unreachable",
    ]);
  });
});
