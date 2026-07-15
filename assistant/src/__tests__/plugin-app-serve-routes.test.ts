import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { UNSUPPORTED_LEGACY_APP_HTML } from "../apps/app-store.js";
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
  test("pages_serve renders a plugin app's compiled dist/index.html", () => {
    installPluginApp("acme", "dash", {
      "dist/index.html":
        "<!DOCTYPE html><html><body><div id='root'>Plugin Home</div></body></html>",
    });
    const handler = findRoute(APP_ROUTES, "pages_serve").handler;
    const html = handler({
      pathParams: { appId: "plugins~acme~dash" },
    } as RouteHandlerArgs) as string;

    expect(html).toContain("Plugin Home");
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("pages_serve serves the unsupported-format message for a legacy single-file plugin app", () => {
    installPluginApp("acme", "old", {
      "index.html": "<div id='root'>Old App</div>",
    });
    const handler = findRoute(APP_ROUTES, "pages_serve").handler;
    const html = handler({
      pathParams: { appId: "plugins~acme~old" },
    } as RouteHandlerArgs) as string;

    expect(html).toContain(UNSUPPORTED_LEGACY_APP_HTML);
    expect(html).not.toContain("Old App");
  });

  test("pages_serve 404s for an unknown / non-plugin id", () => {
    const handler = findRoute(APP_ROUTES, "pages_serve").handler;
    expect(() =>
      handler({
        pathParams: { appId: "plugins~acme~missing" },
      } as RouteHandlerArgs),
    ).toThrow(NotFoundError);
  });

  test("servePageHeaders CSP never allows inline scripts", () => {
    installPluginApp("acme", "multi", {
      "dist/index.html": "<script src='main.js'></script>",
    });
    const route = findRoute(APP_ROUTES, "pages_serve");
    const headersFn = route.responseHeaders as (
      args: ResponseHeaderArgs,
    ) => Record<string, string>;

    const headers = headersFn({ pathParams: { appId: "plugins~acme~multi" } });

    expect(headers["Content-Security-Policy"]).toContain("script-src 'self';");
    expect(headers["Content-Security-Policy"]).not.toContain(
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
      "dist/index.html": "<div id='root'>Plugin Home</div>",
    });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: "plugins~acme~dash" },
    } as RouteHandlerArgs)) as { origin: string; html: string };

    expect(result.origin).toBe("plugin:acme");
    expect(result.html).toContain("Plugin Home");
  });

  test("legacy single-file plugin app opens with the unsupported-format message", async () => {
    installPluginApp("acme", "old", {
      "index.html": "<div id='root'>Old App</div>",
    });
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: "plugins~acme~old" },
    } as RouteHandlerArgs)) as { origin: string; html: string };

    expect(result.origin).toBe("plugin:acme");
    expect(result.html).toContain(UNSUPPORTED_LEGACY_APP_HTML);
    expect(result.html).not.toContain("Old App");
  });

  test("workspace app opens with a workspace origin", async () => {
    // Import lazily so the workspace-dir override from beforeEach is in effect.
    const { createApp, getAppDirPath } = await import("../apps/app-store.js");
    const app = createApp({
      name: "My App",
      schemaJson: "{}",
      htmlDefinition: "",
    });
    const distDir = join(getAppDirPath(app.id), "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      join(distDir, "index.html"),
      "<div id='root'>Workspace Home</div>",
    );
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: app.id },
    } as RouteHandlerArgs)) as { origin: string; html: string };

    expect(result.origin).toBe("workspace");
    expect(result.html).toContain("Workspace Home");
  });
});

describe("bundle import format gate", () => {
  async function buildBundle(formatVersion: number): Promise<Uint8Array> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        format_version: formatVersion,
        name: "Bundled App",
        created_at: "2025-01-01T00:00:00Z",
        created_by: "test",
        entry: "index.html",
        capabilities: [],
      }),
    );
    zip.file("index.html", "<div id='root'>Bundled</div>");
    zip.file("main.js", "console.log('bundled');");
    return zip.generateAsync({ type: "uint8array" });
  }

  test("apps_import_bundle rejects legacy format_version 1 bundles", async () => {
    const rawBody = await buildBundle(1);
    const handler = findRoute(APP_MGMT_ROUTES, "apps_import_bundle").handler;

    await expect(
      handler({
        rawBody,
        headers: { "content-type": "application/octet-stream" },
      } as RouteHandlerArgs),
    ).rejects.toThrow(/format_version 1 is not supported/);
  });

  test("apps_import_bundle imports format_version 2 bundles", async () => {
    const rawBody = await buildBundle(2);
    const handler = findRoute(APP_MGMT_ROUTES, "apps_import_bundle").handler;

    const result = (await handler({
      rawBody,
      headers: { "content-type": "application/octet-stream" },
    } as RouteHandlerArgs)) as { success: boolean; appId: string };

    expect(result.success).toBe(true);
    const { getAppDirPath } = await import("../apps/app-store.js");
    expect(
      existsSync(join(getAppDirPath(result.appId), "dist", "index.html")),
    ).toBe(true);
  });
});

describe("multi-file plugin apps compile on open", () => {
  test("apps_open renders a plugin app with no dist without writing into the plugin tree", async () => {
    installPluginApp("acme", "board", {
      "src/index.html":
        `<!DOCTYPE html><html><head></head><body>` +
        `<div id="root"></div>` +
        `<script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx":
        `import { render } from "preact";\n` +
        `render(<div>Compiled Board</div>, document.getElementById("root")!);\n`,
    });
    const appDir = join(getWorkspacePluginsDir(), "acme", "apps", "board");
    // Precondition: a multi-file app (src/, no root index.html) with no dist yet.
    expect(existsSync(join(appDir, "dist"))).toBe(false);

    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: "plugins~acme~board" },
    } as RouteHandlerArgs)) as { html: string; origin: string };

    // Rendered the compiled output, not the "not compiled yet" fallback.
    expect(result.html).toContain("Compiled Board");
    expect(result.html).not.toContain("not been compiled");
    expect(result.origin).toBe("plugin:acme");
    // The daemon must not write dist/ into the read-only plugin tree — that is
    // the monitor's job. The on-open build happened in a throwaway temp dir.
    expect(existsSync(join(appDir, "dist"))).toBe(false);
  });

  test("apps_open on a malformed plugin app (no src/, no dist/) serves the fallback, not a 500", async () => {
    // An app dir with neither a root index.html nor src/ nor dist/ is
    // classified as multi-file; the on-open compile must not throw.
    installPluginApp("acme", "broken", {});
    const handler = findRoute(APP_MGMT_ROUTES, "apps_open").handler;
    const result = (await handler({
      pathParams: { id: "plugins~acme~broken" },
    } as RouteHandlerArgs)) as { html: string; origin: string };

    expect(result.origin).toBe("plugin:acme");
    expect(result.html).toContain("App compilation failed");
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
