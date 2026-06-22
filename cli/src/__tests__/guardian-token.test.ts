import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { guardianTokenPath, resolveConfigDir } from "@vellumai/local-mode";

import {
  getOrCreatePersistedDeviceId,
  guardianTokenDueForRenewal,
  loadGuardianToken,
  refreshGuardianToken,
  saveGuardianToken,
  seedGuardianTokenFromSiblingEnv,
  type GuardianTokenData,
} from "../lib/guardian-token.js";
import { getConfigDir } from "../lib/environments/paths.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";

function makeTokenData(suffix: string): GuardianTokenData {
  const now = new Date().toISOString();
  const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    guardianPrincipalId: `principal-${suffix}`,
    accessToken: `access-${suffix}`,
    accessTokenExpiresAt: oneHourFromNow,
    refreshToken: `refresh-${suffix}`,
    refreshTokenExpiresAt: oneHourFromNow,
    refreshAfter: oneHourFromNow,
    isNew: true,
    deviceId: `device-${suffix}`,
    leasedAt: now,
  };
}

describe("guardian-token paths are env-scoped", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-token-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedEnv === undefined) {
      delete process.env.VELLUM_ENVIRONMENT;
    } else {
      process.env.VELLUM_ENVIRONMENT = savedEnv;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("prod: guardian token lands at $XDG_CONFIG_HOME/vellum/assistants/<id>/guardian-token.json", () => {
    const data = makeTokenData("prod");
    saveGuardianToken("alpha", data);

    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(prodPath, "utf-8"));
    expect(parsed.guardianPrincipalId).toBe("principal-prod");

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-prod");
  });

  test("dev: guardian token lands at $XDG_CONFIG_HOME/vellum-dev/assistants/<id>/guardian-token.json", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const data = makeTokenData("dev");
    saveGuardianToken("alpha", data);

    const devPath = join(
      tempHome,
      "vellum-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(devPath)).toBe(true);

    // Prod directory must NOT have this token
    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(false);

    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");
  });

  test("same assistant id in prod and dev is isolated on disk", () => {
    // Write prod token for assistant 'alpha'
    delete process.env.VELLUM_ENVIRONMENT;
    saveGuardianToken("alpha", makeTokenData("prod"));

    // Write dev token for assistant 'alpha'
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Dev load returns dev
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-dev",
    );

    // Back to prod — prod token is unchanged
    delete process.env.VELLUM_ENVIRONMENT;
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-prod",
    );

    // Both files exist at distinct paths
    const prodPath = join(
      tempHome,
      "vellum",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    const devPath = join(
      tempHome,
      "vellum-dev",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(prodPath)).toBe(true);
    expect(existsSync(devPath)).toBe(true);
    expect(prodPath).not.toBe(devPath);
  });

  test("prod: persisted device id lands at $XDG_CONFIG_HOME/vellum/device-id", () => {
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const prodPath = join(tempHome, "vellum", "device-id");
    expect(existsSync(prodPath)).toBe(true);
    expect(readFileSync(prodPath, "utf-8").trim()).toBe(id);
  });

  test("dev: persisted device id lands at $XDG_CONFIG_HOME/vellum-dev/device-id", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    const id = getOrCreatePersistedDeviceId();
    expect(id.length).toBeGreaterThan(0);

    const devPath = join(tempHome, "vellum-dev", "device-id");
    expect(existsSync(devPath)).toBe(true);
    expect(readFileSync(devPath, "utf-8").trim()).toBe(id);

    const prodPath = join(tempHome, "vellum", "device-id");
    expect(existsSync(prodPath)).toBe(false);
  });

  test("device id is stable across repeated calls in the same env", () => {
    delete process.env.VELLUM_ENVIRONMENT;
    const first = getOrCreatePersistedDeviceId();
    const second = getOrCreatePersistedDeviceId();
    expect(first).toBe(second);
  });

  test("seedGuardianTokenFromSiblingEnv copies a dev token into the current local env", () => {
    // Write a token under the dev env.
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Switch to local env — no token present yet.
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(loadGuardianToken("alpha")).toBeNull();

    const seeded = seedGuardianTokenFromSiblingEnv("alpha");
    expect(seeded).toBe(true);

    const localPath = join(
      tempHome,
      "vellum-local",
      "assistants",
      "alpha",
      "guardian-token.json",
    );
    expect(existsSync(localPath)).toBe(true);
    const loaded = loadGuardianToken("alpha");
    expect(loaded).not.toBeNull();
    expect(loaded!.guardianPrincipalId).toBe("principal-dev");

    // Idempotent — second call is a no-op.
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
  });

  test("seedGuardianTokenFromSiblingEnv returns false when no sibling token exists", () => {
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("nonexistent")).toBe(false);
    expect(loadGuardianToken("nonexistent")).toBeNull();
  });

  test("seedGuardianTokenFromSiblingEnv does not overwrite an existing token", () => {
    // Token already present in the current env.
    process.env.VELLUM_ENVIRONMENT = "local";
    saveGuardianToken("alpha", makeTokenData("local"));

    // And a different sibling token in dev.
    process.env.VELLUM_ENVIRONMENT = "dev";
    saveGuardianToken("alpha", makeTokenData("dev"));

    // Back to local — seed should no-op because a token is already present.
    process.env.VELLUM_ENVIRONMENT = "local";
    expect(seedGuardianTokenFromSiblingEnv("alpha")).toBe(false);
    expect(loadGuardianToken("alpha")!.guardianPrincipalId).toBe(
      "principal-local",
    );
  });
});

describe("refreshGuardianToken", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;
  const ORIGINAL_FETCH = globalThis.fetch;

  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  function lockPath(id: string): string {
    return join(tempHome, "vellum", "assistants", id, "refresh.lock");
  }

  function seed(refreshExpiresAt: string | number): void {
    saveGuardianToken("px", {
      guardianPrincipalId: "imported",
      accessToken: "old-acc",
      accessTokenExpiresAt: future(),
      refreshToken: "old-ref",
      refreshTokenExpiresAt: refreshExpiresAt,
      refreshAfter: "",
      isNew: false,
      deviceId: "dev",
      leasedAt: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-refresh-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.VELLUM_ENVIRONMENT;
    else process.env.VELLUM_ENVIRONMENT = savedEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test("refreshes, persists the rotated token, sends an abort signal, releases the lock", async () => {
    seed(future());
    let sawSignal = false;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(
        JSON.stringify({
          accessToken: "new-acc",
          refreshToken: "new-ref",
          accessTokenExpiresAt: future(),
          refreshTokenExpiresAt: future(),
          refreshAfter: "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await refreshGuardianToken("https://gw.example.com", "px");

    expect(result?.accessToken).toBe("new-acc");
    expect(loadGuardianToken("px")?.accessToken).toBe("new-acc");
    expect(sawSignal).toBe(true); // fetch carries a timeout AbortSignal
    expect(existsSync(lockPath("px"))).toBe(false); // lock released
  });

  test("returns null without calling the gateway when the refresh token is expired", async () => {
    seed(new Date(Date.now() - 1000).toISOString());
    let called = false;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    expect(
      await refreshGuardianToken("https://gw.example.com", "px"),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when there is no stored token", async () => {
    let called = false;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    expect(
      await refreshGuardianToken("https://gw.example.com", "missing"),
    ).toBeNull();
    expect(called).toBe(false);
  });

  test("steals a stale lock and still refreshes", async () => {
    seed(future());
    // Pre-create a stale lock (mtime well in the past) as if a crashed holder
    // left it behind; the refresh must steal it rather than block.
    const lp = lockPath("px");
    mkdirSync(dirname(lp), { recursive: true });
    writeFileSync(lp, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);

    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ accessToken: "new-acc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const result = await refreshGuardianToken("https://gw.example.com", "px");
    expect(result?.accessToken).toBe("new-acc");
    expect(existsSync(lp)).toBe(false); // stolen lock cleaned up after release
  });

  // The refresh token is long-lived and replayable, so it must only travel over
  // a confidential channel: https, or a loopback host. These guard the
  // plaintext-interception vector flagged in the security review.

  test("sends the refresh token over loopback http (127.0.0.1 / localhost / [::1])", async () => {
    for (const url of [
      "http://127.0.0.1:7830",
      "http://localhost:7830",
      "http://[::1]:7830",
    ]) {
      seed(future());
      let called = false;
      globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
        called = true;
        return new Response(JSON.stringify({ accessToken: "new-acc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      expect(await refreshGuardianToken(url, "px")).not.toBeNull();
      expect(called).toBe(true); // loopback http is allowed
    }
  });

  test("refuses a non-loopback plaintext http URL: no fetch, returns null, warns", async () => {
    seed(future());
    let called = false;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const origWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      expect(
        await refreshGuardianToken("http://10.0.0.5:7830", "px"),
      ).toBeNull();
    } finally {
      console.warn = origWarn;
    }
    expect(called).toBe(false); // the refresh token is never sent
    expect(warned).toBe(true);
  });

  test("refuses a malformed gateway URL: no fetch, returns null", async () => {
    seed(future());
    let called = false;
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(await refreshGuardianToken("not-a-url", "px")).toBeNull();
    } finally {
      console.warn = origWarn;
    }
    expect(called).toBe(false);
  });
});

describe("guardianTokenDueForRenewal", () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const PAST = new Date(Date.now() - 60_000).toISOString();

  function token(over: Partial<GuardianTokenData>): GuardianTokenData {
    return {
      guardianPrincipalId: "p",
      accessToken: "a",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "r",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: "",
      isNew: false,
      deviceId: "d",
      leasedAt: new Date().toISOString(),
      ...over,
    };
  }

  test("past refreshAfter → due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: PAST }))).toBe(
      true,
    );
  });

  test("future refreshAfter → not due", () => {
    expect(guardianTokenDueForRenewal(token({ refreshAfter: FUTURE }))).toBe(
      false,
    );
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (past → due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: PAST }),
      ),
    ).toBe(true);
  });

  test("empty refreshAfter falls back to accessTokenExpiresAt (future → not due)", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "", accessTokenExpiresAt: FUTURE }),
      ),
    ).toBe(false);
  });

  test("unparseable timestamp → not due", () => {
    expect(
      guardianTokenDueForRenewal(
        token({ refreshAfter: "not-a-date", accessTokenExpiresAt: "nope" }),
      ),
    ).toBe(false);
  });
});

// Drift guard between the guardian-token WRITE path (CLI: getGuardianTokenPath
// → getConfigDir(getCurrentEnvironment())) and the READ path used by every
// host-seam reader (getGuardianAccessToken → resolveConfigDir(env) from
// @vellumai/local-mode). A divergence here writes a freshly leased token where
// the connect can't read it, bricking local-assistant connect. saveGuardianToken
// already resolves through the shared resolver; this asserts the two resolvers
// stay in lockstep so a future change to either can't silently relocate tokens.
describe("guardian-token path resolver parity (CLI ↔ shared)", () => {
  let tempHome: string;
  let savedXdg: string | undefined;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedEnv = process.env.VELLUM_ENVIRONMENT;
    tempHome = mkdtempSync(join(tmpdir(), "cli-guardian-parity-test-"));
    process.env.XDG_CONFIG_HOME = tempHome;
    delete process.env.VELLUM_ENVIRONMENT;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnv === undefined) delete process.env.VELLUM_ENVIRONMENT;
    else process.env.VELLUM_ENVIRONMENT = savedEnv;
    rmSync(tempHome, { recursive: true, force: true });
  });

  // The CLI's own resolver and the shared @vellumai/local-mode resolver must
  // agree on the config dir for every environment source.
  const expectResolversAgree = () => {
    expect(getConfigDir(getCurrentEnvironment())).toBe(
      resolveConfigDir(process.env),
    );
  };

  test("unset → production: resolvers agree and saveGuardianToken lands there", () => {
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("prod"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("VELLUM_ENVIRONMENT=dev: resolvers agree and token lands there", () => {
    process.env.VELLUM_ENVIRONMENT = "dev";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("dev"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("VELLUM_ENVIRONMENT=local: resolvers agree and token lands there", () => {
    process.env.VELLUM_ENVIRONMENT = "local";
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("local"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });

  test("persisted default env file (no VELLUM_ENVIRONMENT): resolvers agree", () => {
    // Mirror `vellum env set dev`: the default-env file lives at the fixed,
    // env-agnostic path $XDG_CONFIG_HOME/vellum/environment.
    mkdirSync(join(tempHome, "vellum"), { recursive: true });
    writeFileSync(join(tempHome, "vellum", "environment"), "dev\n");
    expectResolversAgree();
    saveGuardianToken("alpha", makeTokenData("default-dev"));
    expect(
      existsSync(guardianTokenPath(resolveConfigDir(process.env), "alpha")),
    ).toBe(true);
  });
});
