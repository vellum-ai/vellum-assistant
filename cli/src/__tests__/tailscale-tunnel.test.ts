import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeDnsName,
  resolveServeHostname,
  startTailscaleServe,
  stopTailscaleServe,
  type TailscaleCommandResult,
  type TailscaleDeps,
} from "../lib/tailscale-tunnel.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "vellum-tailscale-test-"));
  tempDirs.push(dir);
  return dir;
}

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

afterEach(() => {
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
    expect(info.viaIngress).toBe(false);
    expect(calls).toContainEqual(["serve", "--bg", "7840"]);

    const config = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(config.ingress.publicBaseUrl).toBe(
      "https://my-host.tail-scale.ts.net",
    );
    expect(config.ingress.enabled).toBe(true);
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
