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
  saveLockfileAssistantHost,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
  upgradeLocalAssistantHost,
  wakeLocalAssistantHost,
  getLocalAssistantStatusHost,
  fetchGuardianTokenHost,
  isLocalModeHostAvailable,
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

describe("upgradeLocalAssistantHost", () => {
  test("web/dev host POSTs the assistant id and options to the upgrade middleware", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, version: "v1.2.3" }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(
      await upgradeLocalAssistantHost("a-1", { latest: true }),
    ).toEqual({ ok: true, version: "v1.2.3" });
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
