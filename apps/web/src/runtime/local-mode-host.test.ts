import { afterEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const {
  hatchLocalAssistant,
  loadLockfileHost,
  saveLockfileAssistantHost,
  replacePlatformAssistantsHost,
  retireLocalAssistantHost,
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
    expect(hatch).toHaveBeenCalledWith("vellum");
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
  test("web/dev host POSTs the platform set with the syncPlatform flag", async () => {
    const fetchMock = mock(async () => ({
      json: async () => ({ ok: true, lockfile: {} }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await replacePlatformAssistantsHost([{ assistantId: "p-1" }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/assistant/__local/lockfile");
    expect(JSON.parse(init.body as string)).toEqual({
      syncPlatform: true,
      platformAssistants: [{ assistantId: "p-1" }],
    });
  });

  test("Electron host replaces through the bridge and never touches fetch", async () => {
    const replacePlatformAssistants = mock(async () => ({ ok: true, lockfile: {} }));
    const fetchMock = mock(async () => {
      throw new Error("fetch must not run on the Electron branch");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setElectronBridge({ replacePlatformAssistants });

    await replacePlatformAssistantsHost([{ assistantId: "p-1" }]);

    expect(replacePlatformAssistants).toHaveBeenCalledWith([{ assistantId: "p-1" }]);
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

  test("web/dev host throws the middleware error body on a non-ok response", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "assistant not found" }),
    })) as unknown as typeof fetch;

    await expect(fetchGuardianTokenHost("a-1")).rejects.toThrow(
      "assistant not found",
    );
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

  test("Electron host throws the bridge error when acquisition fails", async () => {
    const guardianToken = mock(async () => ({
      ok: false,
      status: 500,
      error: "refresh failed",
    }));
    setElectronBridge({ guardianToken });

    await expect(fetchGuardianTokenHost("a-1")).rejects.toThrow(
      "refresh failed",
    );
  });
});
