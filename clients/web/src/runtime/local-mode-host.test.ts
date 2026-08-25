import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const {
  GuardianTokenError,
  hatchLocalAssistant,
  loadLockfileHost,
  renameLockfileAssistantHost,
  saveLockfileAssistantHost,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  unpairAssistantHost,
  connectImportHost,
  listPairedDevicesHost,
  revokePairedDeviceHost,
  upgradeLocalAssistantHost,
  wakeLocalAssistantHost,
  getLocalAssistantStatusHost,
  fetchGuardianTokenHost,
  isLocalModeHostAvailable,
  requiresGuardianReprovision,
} = await import("./local-mode-host");

const realFetch = globalThis.fetch;

type WindowWithConfig = {
  vellum?: unknown;
  __VELLUM_CONFIG__?: { mode?: string };
};

beforeEach(() => {
  // Injected config marks the web/dev branch as an available local-mode host,
  // so the HTTP transport runs rather than short-circuiting.
  (window as WindowWithConfig).__VELLUM_CONFIG__ = {};
});

afterEach(() => {
  runningInElectron = false;
  globalThis.fetch = realFetch;
  delete (window as { vellum?: unknown }).vellum;
  delete (window as WindowWithConfig).__VELLUM_CONFIG__;
});

describe("hatchLocalAssistant", () => {
  test("web/dev host POSTs the species to the local-mode middleware and returns its JSON", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, assistantId: "web-1" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await hatchLocalAssistant("openclaw");

    expect(result).toEqual({ ok: true, assistantId: "web-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/hatch");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ species: "openclaw" });
  });

  test('defaults the species to "vellum" when the caller passes none', async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await hatchLocalAssistant();

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({ species: "vellum" });
  });

  test("web/dev host forwards the remote parameter when provided", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, assistantId: "docker-1" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await hatchLocalAssistant(undefined, "docker");

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      species: "vellum",
      remote: "docker",
    });
  });

  test("Electron host routes to the main-process bridge and never touches fetch", async () => {
    runningInElectron = true;
    const hatch = mock(async () => ({ ok: true, assistantId: "electron-1" }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    (
      window as unknown as { vellum: { localMode: { hatch: typeof hatch } } }
    ).vellum = { localMode: { hatch } };

    const result = await hatchLocalAssistant("vellum");

    expect(result).toEqual({ ok: true, assistantId: "electron-1" });
    expect(hatch).toHaveBeenCalledWith("vellum", undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Electron host forwards remote to the bridge", async () => {
    runningInElectron = true;
    const hatch = mock(async () => ({
      ok: true,
      assistantId: "electron-docker-1",
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    (
      window as unknown as { vellum: { localMode: { hatch: typeof hatch } } }
    ).vellum = { localMode: { hatch } };

    const result = await hatchLocalAssistant("vellum", "docker");

    expect(result).toEqual({ ok: true, assistantId: "electron-docker-1" });
    expect(hatch).toHaveBeenCalledWith("vellum", "docker");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const setElectronBridge = (localMode: Record<string, unknown>): void => {
  runningInElectron = true;
  (
    window as unknown as { vellum: { localMode: Record<string, unknown> } }
  ).vellum = { localMode };
};

describe("loadLockfileHost", () => {
  test("web/dev host GETs the lockfile middleware and returns its JSON", async () => {
    const lockfile = { assistants: [], activeAssistant: null };
    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => lockfile,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadLockfileHost()).toEqual(lockfile);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/assistant/__local/lockfile");
  });

  test("web/dev host throws on a non-ok response so callers can fall back", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;

    await expect(loadLockfileHost()).rejects.toThrow("500");
  });

  test("Electron host reads through the bridge and never touches fetch", async () => {
    const lockfile = { assistants: [], activeAssistant: null };
    const readLockfile = mock(async () => lockfile);
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ readLockfile });

    expect(await loadLockfileHost()).toEqual(lockfile);
    expect(readLockfile).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("saveLockfileAssistantHost", () => {
  test("web/dev host POSTs the assistant and active id to the lockfile middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, lockfile: {} }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await saveLockfileAssistantHost({ assistantId: "a-1" }, "a-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      assistant: { assistantId: "a-1" },
      activeAssistant: "a-1",
    });
  });

  test("Electron host writes through the bridge and never touches fetch", async () => {
    const saveLockfileAssistant = mock(async () => ({
      ok: true,
      lockfile: {},
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ saveLockfileAssistant });

    await saveLockfileAssistantHost({ assistantId: "a-1" }, "a-1");

    expect(saveLockfileAssistant).toHaveBeenCalledWith(
      { assistantId: "a-1" },
      "a-1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("renameLockfileAssistantHost", () => {
  test("web/dev host POSTs the rename body shape to the lockfile middleware", async () => {
    const lockfile = { assistants: [], activeAssistant: null };
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, lockfile }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await renameLockfileAssistantHost("a-1", "Credence");

    expect(result).toEqual({ ok: true, lockfile });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      rename: { assistantId: "a-1", name: "Credence" },
    });
  });

  test("web/dev host surfaces the host's structured refusal", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({ ok: false, error: "No lockfile entry" }),
    })) as unknown as typeof fetch;

    const result = await renameLockfileAssistantHost("gone", "Credence");

    expect(result).toEqual({ ok: false, error: "No lockfile entry" });
  });

  test("Electron host renames through the bridge and never touches fetch", async () => {
    const renameLockfileAssistant = mock(async () => ({
      ok: true,
      lockfile: {},
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ renameLockfileAssistant });

    await renameLockfileAssistantHost("a-1", "Credence");

    expect(renameLockfileAssistant).toHaveBeenCalledWith("a-1", "Credence");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the channel refuses without falling back to the upsert", async () => {
    const saveLockfileAssistant = mock(async () => ({
      ok: true,
      lockfile: {},
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ saveLockfileAssistant });

    const result = await renameLockfileAssistantHost("a-1", "Credence");

    expect(result).toEqual({
      ok: false,
      error: "Renaming is not supported by this app version",
    });
    expect(saveLockfileAssistant).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("replacePlatformAssistantsHost", () => {
  test("web/dev host POSTs the platform set and active org with the syncPlatform flag", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, lockfile: {} }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await replacePlatformAssistantsHost([{ assistantId: "p-1" }], "org-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(JSON.parse(init.body as string)).toEqual({
      syncPlatform: true,
      platformAssistants: [{ assistantId: "p-1" }],
      organizationId: "org-1",
    });
  });

  test("Electron host replaces through the bridge with the active org and never touches fetch", async () => {
    const replacePlatformAssistants = mock(async () => ({
      ok: true,
      lockfile: {},
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ replacePlatformAssistants });

    await replacePlatformAssistantsHost([{ assistantId: "p-1" }], "org-1");

    expect(replacePlatformAssistants).toHaveBeenCalledWith(
      [{ assistantId: "p-1" }],
      "org-1",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("retireLocalAssistantHost", () => {
  test("web/dev host POSTs the assistant id to the retire middleware", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await retireLocalAssistantHost("a-1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/retire");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assistantId: "a-1" });
  });

  test("Electron host retires through the bridge and never touches fetch", async () => {
    const retire = mock(async () => ({ ok: true }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ retire });

    expect(await retireLocalAssistantHost("a-1")).toEqual({ ok: true });
    expect(retire).toHaveBeenCalledWith("a-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("unpairAssistantHost", () => {
  const emptyLockfile = { assistants: [], activeAssistant: null };

  test("web/dev host POSTs the assistant id to the unpair middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, lockfile: emptyLockfile }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await unpairAssistantHost("a-1")).toEqual({
      ok: true,
      lockfile: emptyLockfile,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/unpair");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assistantId: "a-1" });
  });

  test("web/dev host surfaces the host's structured refusal", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({ ok: false, error: "No such assistant" }),
    })) as unknown as typeof fetch;

    expect(await unpairAssistantHost("a-1")).toEqual({
      ok: false,
      error: "No such assistant",
    });
  });

  test("Electron host unpairs through the bridge and never touches fetch", async () => {
    const unpair = mock(async () => ({ ok: true, lockfile: emptyLockfile }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ unpair });

    expect(await unpairAssistantHost("a-1")).toEqual({
      ok: true,
      lockfile: emptyLockfile,
    });
    expect(unpair).toHaveBeenCalledWith("a-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the unpair channel reports an unsupported failure", async () => {
    setElectronBridge({});

    expect(await unpairAssistantHost("a-1")).toEqual({
      ok: false,
      error: "Unpair is not supported by this app version",
    });
  });
});

describe("connectImportHost", () => {
  test("web/dev host POSTs the bundle and name to the connect-import middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, assistantId: "desk", accessOnly: false }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await connectImportHost("eyJnYXRld2F5", "desk")).toEqual({
      ok: true,
      assistantId: "desk",
      accessOnly: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/connect-import");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      bundle: "eyJnYXRld2F5",
      name: "desk",
    });
  });

  test("web/dev host surfaces the host's structured refusal", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({
        ok: false,
        error: "An assistant named 'desk' already exists",
      }),
    })) as unknown as typeof fetch;

    expect(await connectImportHost("eyJnYXRld2F5", "desk")).toEqual({
      ok: false,
      error: "An assistant named 'desk' already exists",
    });
  });

  test("Electron host imports through the bridge and never touches fetch", async () => {
    const connectImport = mock(async () => ({
      ok: true,
      assistantId: "paired-dev-1",
      accessOnly: true,
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ connectImport });

    expect(await connectImportHost("eyJnYXRld2F5")).toEqual({
      ok: true,
      assistantId: "paired-dev-1",
      accessOnly: true,
    });
    expect(connectImport).toHaveBeenCalledWith("eyJnYXRld2F5", undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the connectImport channel reports an unsupported failure", async () => {
    setElectronBridge({});

    expect(await connectImportHost("eyJnYXRld2F5")).toEqual({
      ok: false,
      error:
        "Connecting a paired assistant is not supported by this app version",
    });
  });
});

describe("listPairedDevicesHost", () => {
  const devices = [
    {
      hashedDeviceId: "hash-1",
      platform: "ios",
      issuedAt: 1,
      expiresAt: 2,
      lastUsedAt: null,
    },
  ];

  test("web/dev host POSTs the assistant id to the devices middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, devices }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await listPairedDevicesHost("a-1")).toEqual({ ok: true, devices });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/devices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assistantId: "a-1" });
  });

  test("web/dev host surfaces the host's structured refusal", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({ ok: false, error: "No such assistant" }),
    })) as unknown as typeof fetch;

    expect(await listPairedDevicesHost("a-1")).toEqual({
      ok: false,
      error: "No such assistant",
    });
  });

  test("Electron host lists through the bridge and never touches fetch", async () => {
    const listDevices = mock(async () => ({ ok: true, devices }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ listDevices });

    expect(await listPairedDevicesHost("a-1")).toEqual({ ok: true, devices });
    expect(listDevices).toHaveBeenCalledWith("a-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the listDevices channel reports an unsupported failure", async () => {
    setElectronBridge({});

    expect(await listPairedDevicesHost("a-1")).toEqual({
      ok: false,
      error: "Device management is not supported by this app version",
    });
  });
});

describe("revokePairedDeviceHost", () => {
  test("web/dev host POSTs the assistant and hashed device ids to the devices-revoke middleware", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await revokePairedDeviceHost("a-1", "hash-1")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/devices-revoke");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      assistantId: "a-1",
      hashedDeviceId: "hash-1",
    });
  });

  test("web/dev host surfaces the host's structured refusal", async () => {
    globalThis.fetch = mock(async () => ({
      json: async () => ({ ok: false, error: "Device not found" }),
    })) as unknown as typeof fetch;

    expect(await revokePairedDeviceHost("a-1", "hash-1")).toEqual({
      ok: false,
      error: "Device not found",
    });
  });

  test("Electron host revokes through the bridge and never touches fetch", async () => {
    const revokeDevice = mock(async () => ({ ok: true }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ revokeDevice });

    expect(await revokePairedDeviceHost("a-1", "hash-1")).toEqual({ ok: true });
    expect(revokeDevice).toHaveBeenCalledWith("a-1", "hash-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the revokeDevice channel reports an unsupported failure", async () => {
    setElectronBridge({});

    expect(await revokePairedDeviceHost("a-1", "hash-1")).toEqual({
      ok: false,
      error: "Device management is not supported by this app version",
    });
  });
});

describe("wakeLocalAssistantHost", () => {
  test("web/dev host POSTs the assistant id to the wake middleware", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await wakeLocalAssistantHost("a-1")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/wake");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assistantId: "a-1" });
  });

  test("web/dev host forwards repairGuardian when the caller opts in", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await wakeLocalAssistantHost("a-1", { repairGuardian: true });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      assistantId: "a-1",
      repairGuardian: true,
    });
  });

  test("Electron host wakes through the bridge and never touches fetch", async () => {
    const wake = mock(async () => ({ ok: true }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ wake });

    expect(await wakeLocalAssistantHost("a-1")).toEqual({ ok: true });
    expect(wake).toHaveBeenCalledWith("a-1", undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Electron host forwards repairGuardian to the bridge", async () => {
    const wake = mock(async () => ({ ok: true }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ wake });

    expect(
      await wakeLocalAssistantHost("a-1", { repairGuardian: true }),
    ).toEqual({ ok: true });
    expect(wake).toHaveBeenCalledWith("a-1", { repairGuardian: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the wake channel reports an unsupported failure", async () => {
    // The macOS app and web bundle don't release together: a newer renderer
    // can run against a preload that predates the wake IPC channel.
    setElectronBridge({});

    const result = await wakeLocalAssistantHost("a-1");
    expect(result.ok).toBe(false);
  });
});

describe("upgradeLocalAssistantHost", () => {
  test("web/dev host POSTs the assistant id and options to the upgrade middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, version: "v1.2.3" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await upgradeLocalAssistantHost("a-1", { latest: true })).toEqual({
      ok: true,
      version: "v1.2.3",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/assistant/__local/upgrade");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      assistantId: "a-1",
      latest: true,
    });
  });

  test("Electron host upgrades through the bridge and never touches fetch", async () => {
    const upgrade = mock(async () => ({ ok: true, version: "v1.2.3" }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ upgrade });

    expect(
      await upgradeLocalAssistantHost("a-1", { version: "v1.2.3" }),
    ).toEqual({ ok: true, version: "v1.2.3" });
    expect(upgrade).toHaveBeenCalledWith("a-1", { version: "v1.2.3" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("older Electron shell without the upgrade channel reports an unsupported failure", async () => {
    setElectronBridge({});

    expect(await upgradeLocalAssistantHost("a-1")).toEqual({
      ok: false,
      error: "Update and restart the desktop app to enable local upgrades.",
    });
  });
});

describe("getLocalAssistantStatusHost", () => {
  test("web/dev host GETs the local status middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, state: "sleeping" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await getLocalAssistantStatusHost("a 1")).toEqual({
      ok: true,
      state: "sleeping",
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/assistant/__local/status/a%201");
  });

  test("Electron host reads status through the bridge and never touches fetch", async () => {
    const status = mock(async () => ({ ok: true, state: "crashed" }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ status });

    expect(await getLocalAssistantStatusHost("a-1")).toEqual({
      ok: true,
      state: "crashed",
    });
    expect(status).toHaveBeenCalledWith("a-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchGuardianTokenHost", () => {
  test("web/dev host GETs the guardian-token middleware and returns the access token", async () => {
    const fetchMock = mock(async () => ({
      ok: true,
      json: async () => ({ accessToken: "tok-web" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await fetchGuardianTokenHost("a 1")).toBe("tok-web");
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("/assistant/__local/guardian-token/a%201");
  });

  test("web/dev host throws a GuardianTokenError carrying the response status", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "assistant not found" }),
    })) as unknown as typeof fetch;

    const err = await fetchGuardianTokenHost("a-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianTokenError);
    expect((err as InstanceType<typeof GuardianTokenError>).status).toBe(404);
    expect((err as Error).message).toBe("assistant not found");
  });

  test("Electron host reads through the bridge and never touches fetch", async () => {
    const guardianToken = mock(async () => ({
      ok: true,
      accessToken: "tok-electron",
    }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ guardianToken });

    expect(await fetchGuardianTokenHost("a-1")).toBe("tok-electron");
    expect(guardianToken).toHaveBeenCalledWith("a-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Electron host throws a GuardianTokenError carrying the bridge status", async () => {
    const guardianToken = mock(async () => ({
      ok: false,
      status: 500,
      error: "refresh failed",
    }));
    setElectronBridge({ guardianToken });

    const err = await fetchGuardianTokenHost("a-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GuardianTokenError);
    expect((err as InstanceType<typeof GuardianTokenError>).status).toBe(500);
    expect((err as Error).message).toBe("refresh failed");
  });
});

describe("requiresGuardianReprovision", () => {
  test("true only for a missing (404) or spent (401) guardian token", () => {
    expect(requiresGuardianReprovision(new GuardianTokenError(401, "x"))).toBe(
      true,
    );
    expect(requiresGuardianReprovision(new GuardianTokenError(404, "x"))).toBe(
      true,
    );
  });

  test("false for an unreachable gateway or a loopback-boundary refusal", () => {
    expect(requiresGuardianReprovision(new GuardianTokenError(503, "x"))).toBe(
      false,
    );
    expect(requiresGuardianReprovision(new GuardianTokenError(500, "x"))).toBe(
      false,
    );
    expect(requiresGuardianReprovision(new GuardianTokenError(403, "x"))).toBe(
      false,
    );
    expect(requiresGuardianReprovision(new Error("x"))).toBe(false);
  });
});

describe("isLocalModeHostAvailable", () => {
  test("true on the Electron host regardless of injected config", () => {
    runningInElectron = true;
    delete (window as WindowWithConfig).__VELLUM_CONFIG__;
    expect(isLocalModeHostAvailable()).toBe(true);
  });

  test("true on a web/dev host that injects runtime config", () => {
    (window as WindowWithConfig).__VELLUM_CONFIG__ = {};
    expect(isLocalModeHostAvailable()).toBe(true);
  });

  test("false on the managed static build (no injected config)", () => {
    delete (window as WindowWithConfig).__VELLUM_CONFIG__;
    expect(isLocalModeHostAvailable()).toBe(false);
  });

  test("false in remote-gateway mode — the ingress 404s /assistant/__local/*", () => {
    (window as WindowWithConfig).__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    expect(isLocalModeHostAvailable()).toBe(false);
  });
});

describe("web/dev transport resilience", () => {
  // A non-JSON error body makes Response.json() throw; the seam resolves to
  // `{ ok: false }` rather than letting it escape as a throw.
  const nonJsonResponse = () =>
    mock(async () => ({
      status: 405,
      json: async () => {
        throw new SyntaxError("The string did not match the expected pattern.");
      },
    })) as unknown as typeof fetch;

  test("wake returns a failure result instead of throwing on a non-JSON body", async () => {
    globalThis.fetch = nonJsonResponse();
    const result = await wakeLocalAssistantHost("a-1");
    expect(result.ok).toBe(false);
  });

  test("wake short-circuits without a request when no local-mode host is available", async () => {
    delete (window as WindowWithConfig).__VELLUM_CONFIG__;
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run when the host is unavailable");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await wakeLocalAssistantHost("a-1");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("wake returns a failure result when the fetch itself rejects", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("Load failed");
    }) as unknown as typeof fetch;

    const result = await wakeLocalAssistantHost("a-1");
    expect(result.ok).toBe(false);
  });

  test("status returns a failure result instead of throwing on a non-JSON body", async () => {
    globalThis.fetch = nonJsonResponse();
    const result = await getLocalAssistantStatusHost("a-1");
    expect(result.ok).toBe(false);
  });

  test("status short-circuits without a request when no local-mode host is available", async () => {
    delete (window as WindowWithConfig).__VELLUM_CONFIG__;
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run when the host is unavailable");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getLocalAssistantStatusHost("a-1");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
