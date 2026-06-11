/**
 * Tests for {@link inspectPlugin}.
 *
 * The marketplace fetch is replaced with an in-memory fixture passed via the
 * `fetch` dependency, and the installed-copy path is exercised against a real
 * temp directory passed via `workspacePluginsDir` — no globals are monkeypatched.
 * Drift is the exact comparison of the provenance sidecar's commit against the
 * marketplace pin, so the fixtures vary those two SHAs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  inspectPlugin,
  PluginInspectNotFoundError,
} from "../inspect-plugin.js";
import type { FetchLike } from "../install-from-github.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

/** A marketplace manifest object with a single entry for `name`. */
function manifestWith(name: string, ref: string): unknown {
  return {
    name: "vellum",
    plugins: [
      {
        name,
        source: { source: "github", repo: `example-org/${name}`, ref },
        description: "A test plugin.",
        category: "developer",
        homepage: `https://github.com/example-org/${name}`,
        license: "MIT",
      },
    ],
  };
}

/**
 * Build a `fetch` that serves the marketplace manifest. `marketplace:
 * undefined` answers 404 (empty catalog); `fail: true` rejects with a network
 * error. Anything else surfaces a 500 so test bugs are loud.
 */
function makeFetch(opts: { marketplace?: unknown; fail?: boolean }): FetchLike {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("marketplace.json")) {
      if (opts.fail) throw new Error("network down");
      if (opts.marketplace === undefined) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(opts.marketplace), { status: 200 });
    }
    return new Response("unexpected url: " + url, { status: 500 });
  }) as FetchLike;
}

/** Materialize an installed plugin copy with an optional provenance sidecar. */
function installPlugin(
  workspace: string,
  name: string,
  opts: {
    version?: string;
    sidecar?: { commit?: string | null; ref?: string } | null;
  } = {},
): void {
  const dir = join(workspace, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      version: opts.version ?? "0.1.0",
      description: "Installed copy.",
    }),
  );
  if (opts.sidecar !== null) {
    const sidecar = opts.sidecar ?? { commit: SHA_A };
    writeFileSync(
      join(dir, ".vellum-plugin.json"),
      JSON.stringify({
        name,
        source: {
          kind: "github",
          owner: "example-org",
          repo: name,
          ref: sidecar.ref ?? sidecar.commit ?? SHA_A,
        },
        commit: sidecar.commit ?? undefined,
        installedAt: "2026-06-10T12:00:00.000Z",
      }),
    );
  }
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "inspect-plugin-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("inspectPlugin", () => {
  test("reports up-to-date when the installed commit equals the marketplace pin", async () => {
    // GIVEN an installed plugin pinned to the same commit the marketplace pins
    installPlugin(workspace, "level-up", { sidecar: { commit: SHA_A } });
    const fetch = makeFetch({ marketplace: manifestWith("level-up", SHA_A) });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the status is up-to-date and both sides resolve the same commit
    expect(result.status).toBe("up-to-date");
    expect(result.installed).toBe(true);
    expect(result.local?.commit).toBe(SHA_A);
    expect(result.remote?.commit).toBe(SHA_A);
    // AND local + remote metadata are surfaced
    expect(result.local?.version).toBe("0.1.0");
    expect(result.remote?.repo).toBe("example-org/level-up");
    expect(result.remote?.license).toBe("MIT");
  });

  test("reports update-available when the marketplace pin has advanced", async () => {
    // GIVEN an installed plugin whose commit differs from the marketplace pin
    installPlugin(workspace, "level-up", { sidecar: { commit: SHA_A } });
    const fetch = makeFetch({ marketplace: manifestWith("level-up", SHA_B) });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN drift is reported with both commits
    expect(result.status).toBe("update-available");
    expect(result.local?.commit).toBe(SHA_A);
    expect(result.remote?.commit).toBe(SHA_B);
  });

  test("falls back to the sidecar ref when no commit was recorded", async () => {
    // GIVEN a sidecar with no commit but a full-SHA ref equal to the pin
    installPlugin(workspace, "level-up", {
      sidecar: { commit: null, ref: SHA_A },
    });
    const fetch = makeFetch({ marketplace: manifestWith("level-up", SHA_A) });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the ref stands in for the commit and the status is up-to-date
    expect(result.status).toBe("up-to-date");
    expect(result.local?.commit).toBe(SHA_A);
  });

  test("reports unknown-provenance when installed without a resolvable commit", async () => {
    // GIVEN an installed copy with no provenance sidecar at all
    installPlugin(workspace, "level-up", { sidecar: null });
    const fetch = makeFetch({ marketplace: manifestWith("level-up", SHA_A) });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the commit cannot be compared
    expect(result.status).toBe("unknown-provenance");
    expect(result.local?.commit).toBeNull();
    expect(result.remote?.commit).toBe(SHA_A);
  });

  test("reports not-in-marketplace when installed but no entry claims the name", async () => {
    // GIVEN an installed plugin and an empty catalog
    installPlugin(workspace, "level-up", { sidecar: { commit: SHA_A } });
    const fetch = makeFetch({ marketplace: undefined });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN there is no remote to compare against
    expect(result.status).toBe("not-in-marketplace");
    expect(result.installed).toBe(true);
    expect(result.remote).toBeNull();
  });

  test("reports not-installed but previews the marketplace entry", async () => {
    // GIVEN a marketplace entry with no local copy installed
    const fetch = makeFetch({ marketplace: manifestWith("level-up", SHA_B) });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN the remote metadata previews what would be installed
    expect(result.status).toBe("not-installed");
    expect(result.installed).toBe(false);
    expect(result.local).toBeNull();
    expect(result.remote?.commit).toBe(SHA_B);
  });

  test("reports remote-unavailable when the marketplace cannot be reached", async () => {
    // GIVEN an installed plugin and a failing marketplace fetch
    installPlugin(workspace, "level-up", { sidecar: { commit: SHA_A } });
    const fetch = makeFetch({ fail: true });

    // WHEN it is inspected
    const result = await inspectPlugin(
      { name: "level-up" },
      { fetch, workspacePluginsDir: workspace },
    );

    // THEN local info is still reported alongside the fetch error
    expect(result.status).toBe("remote-unavailable");
    expect(result.local?.commit).toBe(SHA_A);
    expect(result.remote).toBeNull();
    expect(result.remoteError).toContain("network down");
  });

  test("throws when the plugin is neither installed nor in the marketplace", async () => {
    // GIVEN no local copy and an empty catalog
    const fetch = makeFetch({ marketplace: undefined });

    // WHEN/THEN inspecting a missing plugin rejects with a not-found error
    await expect(
      inspectPlugin(
        { name: "ghost" },
        { fetch, workspacePluginsDir: workspace },
      ),
    ).rejects.toBeInstanceOf(PluginInspectNotFoundError);
  });
});
