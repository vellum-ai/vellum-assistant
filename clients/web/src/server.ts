/**
 * Local HTTP server for `vellum client --interface web`.
 *
 * Serves a SPA shell at `/` and the React bundle at `/bundle.js`. The bundle
 * is built lazily via `Bun.build` on first request and cached in memory.
 *
 * The same bundle URL is the contract that the platform side will eventually
 * fetch (via runtime `import()`) to embed a specific assistant version's UI.
 * `/bundle.js` therefore advertises permissive CORS.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface StartWebServerOptions {
  /** Port to listen on. Defaults to 3000. */
  port?: number;
  /** Host to bind. Defaults to "127.0.0.1". */
  hostname?: string;
}

interface BundleCache {
  js: string;
  builtAt: number;
}

let bundleCache: BundleCache | null = null;

async function buildBundle(): Promise<BundleCache> {
  if (bundleCache) return bundleCache;
  const entry = path.join(__dirname, "bundle.tsx");
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "inline",
  });
  if (!result.success) {
    const messages = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`@vellumai/web-client: bundle build failed\n${messages}`);
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error("@vellumai/web-client: bundle build produced no outputs");
  }
  const js = await output.text();
  bundleCache = { js, builtAt: Date.now() };
  return bundleCache;
}

export async function startWebServer(
  opts: StartWebServerOptions = {},
): Promise<ReturnType<typeof Bun.serve>> {
  const port = opts.port ?? 3000;
  const hostname = opts.hostname ?? "127.0.0.1";

  // Pre-build the bundle so the first request is fast and any build errors
  // surface before we start listening.
  await buildBundle();

  const indexHtml = await Bun.file(path.join(__dirname, "index.html")).text();

  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        return new Response(indexHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/bundle.js") {
        const { js } = await buildBundle();
        return new Response(js, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            // Platform consumers will fetch this from a different origin.
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}

// Allow `bun src/server.ts` for standalone dev iteration without the CLI.
if (import.meta.main) {
  const server = await startWebServer();
  console.log(
    `@vellumai/web-client listening on http://${server.hostname}:${server.port}`,
  );
}
