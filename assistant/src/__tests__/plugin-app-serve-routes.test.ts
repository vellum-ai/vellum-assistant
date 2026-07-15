import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ROUTES as APP_MGMT_ROUTES } from "../runtime/routes/app-management-routes.js";
import { ROUTES as APP_ROUTES } from "../runtime/routes/app-routes.js";
import { BadRequestError, NotFoundError } from "../runtime/routes/errors.js";
import type {
  ResponseHeaderArgs,
  RouteDefinition,
  RouteHandlerArgs,
} from "../runtime/routes/types.js";
import { getWorkspacePluginsDir } from "../util/platform.js";

let workspaceDir: string;

function findRoute(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route not found: ${operationId}`);
  }
  return route;
}

/** Install a plugin with a package.json and one bundled app directory. */
function installPluginApp(
  plugin: string,
  app: string,
  files: Record<string, string>,
): void {
  const appDir = join(getWorkspacePluginsDir(), plugin, "apps", app);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(getWorkspacePluginsDir(), plugin, "package.json"),
    JSON.stringify({ name: plugin, version: "1.0.0" }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = join(appDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-plugin-serve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("plugin app serve routes", () => {
  test("pages_serve renders a single-file plugin app's index.html", () => {
    installPluginApp("acme", "dash", {
      "index.html": "<div id='root'>Plugin Home</div>",
    });
    const handler = findRoute(APP_ROUTES, "pages_serve").handler;
    const html = handler({
      pathParams: { appId: "plugins~acme~dash" },
    } as RouteHandlerArgs) as string;

    expect(html).toContain("Plugin Home");
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("pages_serve 404s for an unknown / non-plugin id", () => {
    const handler = findRoute(APP_ROUTES, "pages_serve").handler;
    expect(() =>
      handler({
        pathParams: { appId: "plugins~acme~missing" },
      } as RouteHandlerArgs),
    ).toThrow(NotFoundError);
  });

  test("servePageHeaders CSP: single-file allows inline scripts, multifile does not", () => {
    installPluginApp("acme", "single", {
      "index.html": "<div>x</div>",
    });
    installPluginApp("acme", "multi", {
      "dist/index.html": "<script src='main.js'></script>",
    });
    const route = findRoute(APP_ROUTES, "pages_serve");
    const headersFn = route.responseHeaders as (
      args: ResponseHeaderArgs,
    ) => Record<string, string>;

    const single = headersFn({ pathParams: { appId: "plugins~acme~single" } });
    const multi = headersFn({ pathParams: { appId: "plugins~acme~multi" } });

    expect(single["Content-Security-Policy"]).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(multi["Content-Security-Policy"]).toContain("script-src 'self';");
    expect(multi["Content-Security-Policy"]).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  test("apps_asset serves a bundled asset from a plugin app dir", () => {
    installPluginApp("acme", "dash", {
      "index.html": "<div>x</div>",
      "logo.svg": "<svg>logo</svg>",
    });
    const handler = findRoute(APP_ROUTES, "apps_asset").handler;
    const bytes = handler({
      pathParams: { appId: "plugins~acme~dash", path: "logo.svg" },
    } as RouteHandlerArgs) as Uint8Array;

    expect(Buffer.from(bytes).toString("utf-8")).toBe("<svg>logo</svg>");
  });

  test("apps_asset rejects traversal out of a plugin app dir", () => {
    installPluginApp("acme", "dash", { "index.html": "<div>x</div>" });
    const handler = findRoute(APP_ROUTES, "apps_asset").handler;
    expect(() =>
      handler({
        pathParams: { appId: "plugins~acme~dash", path: "../../package.json" },
      } as RouteHandlerArgs),
    ).toThrow(BadRequestError);
  });

  test("apps_dist_file serves a compiled asset from a plugin app dist/", () => {
    installPluginApp("acme", "multi", {
      "dist/index.html": "<html></html>",
      "dist/main.js": "console.log(1)",
    });
    const handler = findRoute(APP_ROUTES, "apps_dist_file").handler;
    const bytes = handler({
      pathParams: { appId: "plugins~acme~multi", filename: "main.js" },
    } as RouteHandlerArgs) as Uint8Array;

    expect(Buffer.from(bytes).toString("utf-8")).toBe("console.log(1)");
  });
});

describe("apps_open reports app origin", () => {
  test("plugin app opens with a plugin:<name> origin", async () => {
    installPluginApp("acme", "dash", {
      "index.html": "<div id='root'>Plugin Home</div>",
    });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: "plugins~acme~dash" },
    } as RouteHandlerArgs)) as { origin: string; html: string };

    expect(result.origin).toBe("plugin:acme");
    expect(result.html).toContain("Plugin Home");
  });

  test("workspace app opens with a workspace origin", async () => {
    // Import lazily so the workspace-dir override from beforeEach is in effect.
    const { createApp } = await import("../apps/app-store.js");
    const app = createApp({
      name: "My App",
      schemaJson: "{}",
      htmlDefinition: "<div id='root'>Workspace Home</div>",
    });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: app.id },
    } as RouteHandlerArgs)) as { origin: string; html: string };

    expect(result.origin).toBe("workspace");
    expect(result.html).toContain("Workspace Home");
  });
});

describe("plugin apps are read-only over the management surface", () => {
  test("apps_delete rejects a plugin app id", () => {
    installPluginApp("acme", "dash", { "index.html": "<div>x</div>" });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_delete").handler;
    expect(() =>
      handler({
        pathParams: { id: "plugins~acme~dash" },
        headers: {},
      } as RouteHandlerArgs),
    ).toThrow(BadRequestError);
  });

  test("apps_data_mutate rejects a plugin app id", () => {
    installPluginApp("acme", "dash", { "index.html": "<div>x</div>" });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_data_mutate").handler;
    expect(() =>
      handler({
        pathParams: { id: "plugins~acme~dash" },
        body: { method: "create", data: {} },
      } as RouteHandlerArgs),
    ).toThrow(BadRequestError);
  });
});
