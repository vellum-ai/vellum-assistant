import { afterEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const {
  GuardianTokenError,
  hatchLocalAssistant,
  loadLockfileHost,
  saveLockfileAssistantHost,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  wakeLocalAssistantHost,
  fetchGuardianTokenHost,
} = await import("./local-mode-host");

const realFetch = globalThis.fetch;

afterEach(() => {
  runningInElectron = false;
  globalThis.fetch = realFetch;
  delete (window as { vellum?: unknown }).vellum;
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

  test("defaults the species to \"vellum\" when the caller passes none", async () => {
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
    expect(JSON.parse(init.body as string)).toEqual({ species: "vellum", remote: "docker" });
  });

  test("Electron host routes to the main-process bridge and never touches fetch", async () => {
    runningInElectron = true;
    const hatch = mock(async () => ({ ok: true, assistantId: "electron-1" }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    (window as unknown as { vellum: { localMode: { hatch: typeof hatch } } }).vellum =
      { localMode: { hatch } };

    const result = await hatchLocalAssistant("vellum");

    expect(result).toEqual({ ok: true, assistantId: "electron-1" });
    expect(hatch).toHaveBeenCalledWith("vellum", undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("Electron host forwards remote to the bridge", async () => {
    runningInElectron = true;
    const hatch = mock(async () => ({ ok: true, assistantId: "electron-docker-1" }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    (window as unknown as { vellum: { localMode: { hatch: typeof hatch } } }).vellum =
      { localMode: { hatch } };

    const result = await hatchLocalAssistant("vellum", "docker");

    expect(result).toEqual({ ok: true, assistantId: "electron-docker-1" });
    expect(hatch).toHaveBeenCalledWith("vellum", "docker");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const setElectronBridge = (localMode: Record<string, unknown>): void => {
  runningInElectron = true;
  (window as unknown as { vellum: { localMode: Record<string, unknown> } }).vellum =
    { localMode };
};

describe("loadLockfileHost", () => {
  test("web/dev host GETs the lockfile middleware and returns its JSON", async () => {
    const lockfile = { assistants: [], activeAssistant: null };
    const fetchMock = mock(async () => ({ ok: true, json: async () => lockfile }));
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

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      assistant: { assistantId: "a-1" },
      activeAssistant: "a-1",
    });
  });

  test("Electron host writes through the bridge and never touches fetch", async () => {
    const saveLockfileAssistant = mock(async () => ({ ok: true, lockfile: {} }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ saveLockfileAssistant });

    await saveLockfileAssistantHost({ assistantId: "a-1" }, "a-1");

    expect(saveLockfileAssistant).toHaveBeenCalledWith({ assistantId: "a-1" }, "a-1");
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

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(JSON.parse(init.body as string)).toEqual({
      syncPlatform: true,
      platformAssistants: [{ assistantId: "p-1" }],
      organizationId: "org-1",
    });
  });

  test("Electron host replaces through the bridge with the active org and never touches fetch", async () => {
    const replacePlatformAssistants = mock(async () => ({ ok: true, lockfile: {} }));
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

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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

describe("wakeLocalAssistantHost", () => {
  test("web/dev host POSTs the assistant id to the wake middleware", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await wakeLocalAssistantHost("a-1")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/assistant/__local/wake");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ assistantId: "a-1" });
  });

  test("web/dev host forwards repairGuardian when the caller opts in", async () => {
    const fetchMock = mock(async () => ({ json: async () => ({ ok: true }) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await wakeLocalAssistantHost("a-1", { repairGuardian: true });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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
