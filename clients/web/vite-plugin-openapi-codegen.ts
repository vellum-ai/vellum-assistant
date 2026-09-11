import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath, type Plugin, type ResolvedConfig } from "vite";

const execFileAsync = promisify(execFile);

export function openApiCodegenPlugin(): Plugin {
  let config: ResolvedConfig;
  let inputs: Set<string>;
  let pending = Promise.resolve();
  let stopWatching: (() => void) | undefined;
  const generate = async () => {
    config.logger.info("Regenerating API clients...");
    await execFileAsync(
      process.versions.bun ? process.execPath : "bun",
      ["run", "openapi-ts"],
      { cwd: config.root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
  };
  return {
    name: "openapi-codegen",
    apply: "serve",
    async configResolved(resolved) {
      config = resolved;
      inputs = new Set(
        [
          "../../assistant/openapi.yaml",
          "../../gateway/openapi.yaml",
          "openapi-schemas/platform.yaml",
          "openapi-schemas/auth.yaml",
          "openapi-ts.config.ts",
          "scripts/transform-daemon-spec.ts",
          "scripts/transform-gateway-spec.ts",
        ].map((input) => normalizePath(path.resolve(config.root, input))),
      );
      await generate();
    },
    configureServer(server) {
      server.watcher.add([...inputs]);
      const changed = (event: string, file: string) => {
        if (
          !inputs.has(normalizePath(file)) ||
          !["add", "change", "unlink"].includes(event)
        ) {
          return;
        }
        pending = pending
          .then(generate)
          .then(() => {
            server.moduleGraph.invalidateAll();
            server.ws.send({ type: "full-reload" });
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            config.logger.error(message);
            server.ws.send({
              type: "error",
              err: { message, stack: "", plugin: "openapi-codegen" },
            });
          });
      };
      server.watcher.on("all", changed);
      stopWatching = () => server.watcher.off("all", changed);
    },
    async closeBundle() {
      stopWatching?.();
      await pending;
    },
  };
}
