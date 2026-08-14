import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getPluginReadiness,
  markPluginFailed,
  markPluginInitializing,
  markPluginReady,
  resetPluginReadinessForTests,
} from "../../../plugins/plugin-readiness.js";
import { resetPluginRouteManifestCacheForTests } from "../../../plugins/plugin-route-manifest.js";
import { getWorkspacePluginsDir } from "../../../util/platform.js";
import { UserRouteDispatcher } from "../user-route-dispatcher.js";

const SOURCE_FINGERPRINT = "a".repeat(64);

function writeRouteFixture(
  pluginId: string,
  opts: { optsIntoReadiness?: boolean } = { optsIntoReadiness: true },
): string {
  const pluginDir = join(getWorkspacePluginsDir(), pluginId);
  const routesDir = join(pluginDir, "routes");
  const marker = join(pluginDir, "imported");
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({
      name: pluginId,
      ...(opts.optsIntoReadiness
        ? { peerDependencies: { "@vellumai/plugin-api": "*" } }
        : {}),
    }),
  );
  if (opts.optsIntoReadiness) {
    writeFileSync(
      join(pluginDir, "host-requirements.json"),
      JSON.stringify({
        schemaVersion: 1,
        requires: { "plugins.readiness": "^1.0.0" },
      }),
    );
  }
  writeFileSync(
    join(routesDir, "status.ts"),
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(marker)}, "yes");
     export function GET() { return Response.json({ ok: true }); }`,
  );
  writeFileSync(
    join(routesDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      routes: [
        {
          path: "status",
          method: "GET",
          authorization: {
            principal: "actor",
            requiredScopes: ["settings.read"],
          },
        },
      ],
    }),
  );
  return marker;
}

async function dispatch(pluginId: string, method = "GET"): Promise<Response> {
  return new UserRouteDispatcher().dispatch(
    `plugins/${pluginId}/status`,
    new Request("http://localhost/v1/x/status", { method }),
  );
}

beforeEach(() => {
  resetPluginReadinessForTests();
  resetPluginRouteManifestCacheForTests();
});

afterEach(() => {
  resetPluginReadinessForTests();
  resetPluginRouteManifestCacheForTests();
  rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
});

describe("plugin route readiness", () => {
  test("serves a legacy plugin route without readiness state", async () => {
    const pluginId = "legacy-route";
    const marker = writeRouteFixture(pluginId, { optsIntoReadiness: false });

    const response = await dispatch(pluginId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(existsSync(marker)).toBe(true);
  });

  test("keeps the timestamp for an unchanged readiness state", async () => {
    const pluginId = "stable-readiness";
    markPluginFailed(pluginId, SOURCE_FINGERPRINT, "initialization failed");
    const firstUpdatedAt = getPluginReadiness(pluginId)?.updatedAt;

    await Bun.sleep(2);
    markPluginFailed(pluginId, SOURCE_FINGERPRINT, "initialization failed");

    expect(getPluginReadiness(pluginId)?.updatedAt).toBe(firstUpdatedAt);

    await Bun.sleep(2);
    markPluginFailed(pluginId, SOURCE_FINGERPRINT, "different failure");
    expect(getPluginReadiness(pluginId)?.updatedAt).not.toBe(firstUpdatedAt);
  });

  test("returns initializing before importing an opted-in plugin route", async () => {
    const pluginId = "initializing-route";
    const marker = writeRouteFixture(pluginId);

    const response = await dispatch(pluginId);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("plugin_initializing");
    expect(body.error.details).toMatchObject({
      pluginId,
      status: "initializing",
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("fails closed on an invalid readiness opt-in", async () => {
    const pluginId = "invalid-readiness-opt-in";
    const marker = writeRouteFixture(pluginId);
    writeFileSync(
      join(getWorkspacePluginsDir(), pluginId, "host-requirements.json"),
      "{invalid",
    );

    const response = await dispatch(pluginId);

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatchObject({
      code: "plugin_incompatible",
      details: { pluginId, status: "incompatible" },
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("keeps failed generations inert and serves only a ready generation", async () => {
    const pluginId = "generation-route";
    const marker = writeRouteFixture(pluginId);

    markPluginInitializing(pluginId, SOURCE_FINGERPRINT);
    const initializing = await dispatch(pluginId);
    expect(initializing.status).toBe(503);
    expect((await initializing.json()).error.code).toBe("plugin_initializing");
    expect(existsSync(marker)).toBe(false);

    markPluginFailed(
      pluginId,
      SOURCE_FINGERPRINT,
      "fixture initialization failed",
    );
    const failed = await dispatch(pluginId);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toMatchObject({
      code: "plugin_initialization_failed",
      message: "fixture initialization failed",
    });
    expect(existsSync(marker)).toBe(false);

    markPluginReady(pluginId, SOURCE_FINGERPRINT);
    const ready = await dispatch(pluginId);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true });
    expect(existsSync(marker)).toBe(true);
  });

  test("does not import a route behind an invalid static manifest", async () => {
    const pluginId = "invalid-route-manifest";
    const marker = writeRouteFixture(pluginId);
    const manifestPath = join(
      getWorkspacePluginsDir(),
      pluginId,
      "routes",
      "manifest.json",
    );
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{invalid");
    resetPluginRouteManifestCacheForTests();
    markPluginReady(pluginId, SOURCE_FINGERPRINT);

    const response = await dispatch(pluginId);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "plugin_route_manifest_invalid",
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("rejects a mutating actor route with read-only scopes before import", async () => {
    const pluginId = "read-only-mutation";
    const marker = writeRouteFixture(pluginId);
    const manifestPath = join(
      getWorkspacePluginsDir(),
      pluginId,
      "routes",
      "manifest.json",
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        routes: [
          {
            path: "status",
            method: "PATCH",
            authorization: {
              principal: "actor",
              requiredScopes: ["settings.read"],
            },
          },
        ],
      }),
    );
    resetPluginRouteManifestCacheForTests();
    markPluginReady(pluginId, SOURCE_FINGERPRINT);

    const response = await dispatch(pluginId, "PATCH");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "plugin_route_manifest_invalid",
    );
    expect(existsSync(marker)).toBe(false);
  });
});
