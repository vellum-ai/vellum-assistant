import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getTailscaleBinaryCandidates,
  getTailscaleInstallMessage,
  normalizeDnsName,
  resolveServeHostname,
  retractServeUrl,
  shouldClearIngressUrl,
  startTailscaleServe,
  stopTailscaleServe,
  type TailscaleCommandResult,
  type TailscaleDeps,
} from "../lib/tailscale-tunnel.js";
import { snapshotEnv } from "./helpers/env.js";

describe("Tailscale discovery", () => {
  test("checks PATH and standard Windows install locations", () => {
    expect(
      getTailscaleBinaryCandidates("win32", {
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local",
      }),
    ).toEqual([
      "tailscale.exe",
      "C:\\Program Files\\Tailscale\\tailscale.exe",
      "C:\\Users\\Example\\AppData\\Local\\Tailscale\\tailscale.exe",
    ]);
  });

  test("provides Windows installation guidance", () => {
    expect(getTailscaleInstallMessage("win32")).toContain(
      "winget install Tailscale.Tailscale",
    );
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-tailscale-test-"));
  tempDirs.push(dir);
  return dir;
}

const TAILNET_URL = "https://my-host.tail-scale.ts.net";

const RUNNING_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "my-host.tail-scale.ts.net.", Online: true },
});

const ok = (stdout = "", stderr = ""): TailscaleCommandResult => ({
  status: 0,
  stdout,
  stderr,
});

/**
 * Build a fake {@link TailscaleDeps}. `binary` defaults to a present binary;
 * pass `null` to simulate a missing install. `responses` is keyed by the
 * space-joined args; unmatched calls return an empty success result.
 */
function makeDeps(opts: {
  binary?: string | null;
  responses?: Record<string, TailscaleCommandResult>;
}): { deps: TailscaleDeps; calls: string[][] } {
  const calls: string[][] = [];
  const binary = opts.binary === undefined ? "tailscale" : opts.binary;
  const deps: TailscaleDeps = {
    findBinary: () => binary,
    run: (_bin, args) => {
      calls.push(args);
      return opts.responses?.[args.join(" ")] ?? ok();
    },
  };
  return { deps, calls };
}

/** Point the lockfile at a temp dir holding one entry; returns its path. */
function useTempLockfile(assistantId: string, ingressUrl?: string): string {
  const lockfileDir = makeWorkspace();
  process.env.VELLUM_LOCKFILE_DIR = lockfileDir;
  const lockfilePath = join(lockfileDir, ".vellum.lock.json");
  writeFileSync(
    lockfilePath,
    JSON.stringify({
      activeAssistant: assistantId,
      assistants: [
        {
          assistantId,
          runtimeUrl: "http://127.0.0.1:7830",
          cloud: "local",
          ...(ingressUrl ? { ingressUrl } : {}),
        },
      ],
    }),
  );
  return lockfilePath;
}

interface WorkspaceIngressConfig {
  ingress: {
    enabled?: boolean;
    publicBaseUrl?: string;
    assistantId?: string;
    lastTunnel?: { provider: string; publicBaseUrl: string };
    pairingTunnel?: { provider: string; publicBaseUrl: string };
  };
}

function readConfig(workspaceDir: string): WorkspaceIngressConfig {
  return JSON.parse(
    readFileSync(join(workspaceDir, "config.json"), "utf-8"),
  ) as WorkspaceIngressConfig;
}

/** A workspace whose ingress base URL is a live webhook callback base. */
function writePreservedConfig(workspaceDir: string, webhookBase: string): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify({
      ingress: {
        enabled: true,
        publicBaseUrl: webhookBase,
        lastTunnel: { provider: "ngrok", publicBaseUrl: webhookBase },
      },
    }),
  );
}

function readLockfileEntry(lockfilePath: string): Record<string, unknown> {
  const data = JSON.parse(readFileSync(lockfilePath, "utf-8")) as {
    assistants: Record<string, unknown>[];
  };
  return data.assistants[0];
}

const restoreEnv = snapshotEnv(["VELLUM_LOCKFILE_DIR"]);

afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── normalizeDnsName ────────────────────────────────────────────────────────

describe("normalizeDnsName", () => {
  test("trims the trailing MagicDNS dot", () => {
    expect(normalizeDnsName("host.tailnet.ts.net.")).toBe(
      "host.tailnet.ts.net",
    );
  });

  test("leaves a name without a trailing dot unchanged", () => {
    expect(normalizeDnsName("host.tailnet.ts.net")).toBe("host.tailnet.ts.net");
  });
});

// ── resolveServeHostname ──────────────────────────────────────────────────────

describe("resolveServeHostname", () => {
  test("returns the trimmed Self.DNSName for a running node", () => {
    expect(resolveServeHostname(RUNNING_STATUS)).toBe(
      "my-host.tail-scale.ts.net",
    );
  });

  test("throws a login hint when logged out", () => {
    const json = JSON.stringify({ BackendState: "NeedsLogin", Self: {} });
    expect(() => resolveServeHostname(json)).toThrow("not logged in");
  });

  test("throws when the backend is not running", () => {
    const json = JSON.stringify({
      BackendState: "Stopped",
      Self: { DNSName: "host.ts.net." },
    });
    expect(() => resolveServeHostname(json)).toThrow("not ready");
  });

  test("throws when the DNS name is missing", () => {
    const json = JSON.stringify({ BackendState: "Running", Self: {} });
    expect(() => resolveServeHostname(json)).toThrow("DNS name");
  });

  test("throws on unparseable JSON", () => {
    expect(() => resolveServeHostname("not json")).toThrow("Could not parse");
  });
});

// ── startTailscaleServe ───────────────────────────────────────────────────────

describe("startTailscaleServe", () => {
  test("throws install guidance when the binary is missing", async () => {
    const { deps, calls } = makeDeps({ binary: null });
    await expect(
      startTailscaleServe({ port: 7840, workspaceDir: makeWorkspace() }, deps),
    ).rejects.toThrow("Tailscale is not installed");
    expect(calls).toHaveLength(0);
  });

  test("throws a login hint when logged out and never calls serve", async () => {
    const { deps, calls } = makeDeps({
      responses: {
        "status --json": ok(
          JSON.stringify({ BackendState: "NeedsLogin", Self: {} }),
        ),
      },
    });
    await expect(
      startTailscaleServe({ port: 7840, workspaceDir: makeWorkspace() }, deps),
    ).rejects.toThrow("not logged in");
    expect(calls).not.toContainEqual(["serve", "--bg", "7840"]);
  });

  test("throws when the status query fails (daemon down)", async () => {
    const { deps } = makeDeps({
      responses: {
        "status --json": {
          status: 1,
          stdout: "",
          stderr: "failed to connect to local tailscaled",
        },
      },
    });
    await expect(
      startTailscaleServe({ port: 7840, workspaceDir: makeWorkspace() }, deps),
    ).rejects.toThrow("Could not query Tailscale");
  });

  test("serves the target port and persists the ingress URL on success", async () => {
    const workspaceDir = makeWorkspace();
    const { deps, calls } = makeDeps({
      responses: {
        "status --json": ok(RUNNING_STATUS),
        "serve --bg 7840": ok(),
      },
    });

    const info = await startTailscaleServe({ port: 7840, workspaceDir }, deps);

    expect(info.publicUrl).toBe("https://my-host.tail-scale.ts.net");
    expect(info.port).toBe(7840);
    expect(calls).toContainEqual(["serve", "--bg", "7840"]);

    const config = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(config.ingress.publicBaseUrl).toBe(
      "https://my-host.tail-scale.ts.net",
    );
    expect(config.ingress.enabled).toBe(true);
  });

  test("preserveIngressUrl records a pairing tunnel and leaves the ingress record", async () => {
    const workspaceDir = makeWorkspace();
    const webhookBase = "https://existing.ngrok.app";
    writePreservedConfig(workspaceDir, webhookBase);
    const lockfilePath = useTempLockfile("ts-1");
    const { deps } = makeDeps({
      responses: {
        "status --json": ok(RUNNING_STATUS),
        "serve --bg 7840": ok(),
      },
    });

    const info = await startTailscaleServe(
      {
        port: 7840,
        workspaceDir,
        assistantId: "ts-1",
        preserveIngressUrl: true,
      },
      deps,
    );

    // The webhook callback base and the tunnel it names survive untouched...
    const config = readConfig(workspaceDir);
    expect(config.ingress.publicBaseUrl).toBe(webhookBase);
    expect(config.ingress.lastTunnel?.provider).toBe("ngrok");
    // ...while the tailnet URL is recorded as the address to pair against, in
    // the workspace config the daemon's status route reads...
    expect(config.ingress.pairingTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: TAILNET_URL,
    });
    expect(config.ingress.assistantId).toBe("ts-1");
    // ...and on the lockfile entry, where CLI pairing reads its default.
    expect(readLockfileEntry(lockfilePath).ingressUrl).toBe(TAILNET_URL);
    expect(info.previousLockfileIngressUrl).toBeNull();
  });

  test("preserveIngressUrl reports the lockfile URL it replaced", async () => {
    const workspaceDir = makeWorkspace();
    writePreservedConfig(workspaceDir, "https://existing.ngrok.app");
    useTempLockfile("ts-1", "https://existing.ngrok.app");
    const { deps } = makeDeps({
      responses: {
        "status --json": ok(RUNNING_STATUS),
        "serve --bg 7840": ok(),
      },
    });

    const info = await startTailscaleServe(
      {
        port: 7840,
        workspaceDir,
        assistantId: "ts-1",
        preserveIngressUrl: true,
      },
      deps,
    );

    expect(info.previousLockfileIngressUrl).toBe("https://existing.ngrok.app");
  });

  test("surfaces tailscale's enable-URL guidance when serve is not enabled", async () => {
    const workspaceDir = makeWorkspace();
    const enableUrl = "https://login.tailscale.com/f/serve?node=abc123";
    const { deps } = makeDeps({
      responses: {
        "status --json": ok(RUNNING_STATUS),
        "serve --bg 7840": {
          status: 1,
          stdout: "",
          stderr: `error: Serve is not enabled on your tailnet.\n\nTo enable, visit:\n  ${enableUrl}`,
        },
      },
    });

    await expect(
      startTailscaleServe({ port: 7840, workspaceDir }, deps),
    ).rejects.toThrow(enableUrl);

    // A failed serve must not persist an ingress URL.
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });
});

// ── stopTailscaleServe ────────────────────────────────────────────────────────

describe("stopTailscaleServe", () => {
  test("turns off the HTTPS:443 serve (narrow off form)", () => {
    const { deps, calls } = makeDeps({
      responses: { "serve --https=443 off": ok() },
    });
    const result = stopTailscaleServe("tailscale", deps);
    expect(result.status).toBe(0);
    expect(calls).toContainEqual(["serve", "--https=443", "off"]);
  });
});

// ── retractServeUrl ───────────────────────────────────────────────────────────

describe("retractServeUrl", () => {
  const PRESERVE_OPTS = { assistantId: "ts-1", preserveIngressUrl: true };

  test("puts back the lockfile URL the run replaced", () => {
    // The preserved webhook tunnel may still be serving that address, and the
    // flows that read the lockfile would otherwise lose a live one.
    const workspaceDir = makeWorkspace();
    writePreservedConfig(workspaceDir, "https://existing.ngrok.app");
    const lockfilePath = useTempLockfile("ts-1", TAILNET_URL);

    retractServeUrl(PRESERVE_OPTS, workspaceDir, "https://existing.ngrok.app");

    expect(readLockfileEntry(lockfilePath).ingressUrl).toBe(
      "https://existing.ngrok.app",
    );
    // The pairing record goes, the webhook callback base stays.
    const config = readConfig(workspaceDir);
    expect(config.ingress.pairingTunnel).toBeUndefined();
    expect(config.ingress.publicBaseUrl).toBe("https://existing.ngrok.app");
    expect(config.ingress.lastTunnel?.provider).toBe("ngrok");
  });

  test("clears the lockfile URL when the run replaced none", () => {
    const workspaceDir = makeWorkspace();
    writePreservedConfig(workspaceDir, "https://existing.ngrok.app");
    const lockfilePath = useTempLockfile("ts-1", TAILNET_URL);

    retractServeUrl(PRESERVE_OPTS, workspaceDir, null);

    expect(readLockfileEntry(lockfilePath).ingressUrl).toBeUndefined();
  });

  test("clears the ingress URL outright when it owns it", () => {
    const workspaceDir = makeWorkspace();
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({
        ingress: { enabled: true, publicBaseUrl: TAILNET_URL },
      }),
    );
    const lockfilePath = useTempLockfile("ts-1", TAILNET_URL);

    retractServeUrl({ assistantId: "ts-1" }, workspaceDir, TAILNET_URL);

    expect(readConfig(workspaceDir).ingress.publicBaseUrl).toBeUndefined();
    expect(readLockfileEntry(lockfilePath).ingressUrl).toBeUndefined();
  });
});

// ── shouldClearIngressUrl ─────────────────────────────────────────────────────

describe("shouldClearIngressUrl", () => {
  test("clears only after a confirmed successful stop", () => {
    expect(shouldClearIngressUrl({ status: 0, stdout: "", stderr: "" })).toBe(
      true,
    );
  });

  test("keeps the URL when the stop command fails", () => {
    expect(
      shouldClearIngressUrl({ status: 1, stdout: "", stderr: "boom" }),
    ).toBe(false);
  });

  test("keeps the URL when the stop command threw before running", () => {
    expect(shouldClearIngressUrl(null)).toBe(false);
  });
});
