import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath, type Plugin } from "vite";

const execFileAsync = promisify(execFile);

export function openApiCodegenPlugin(): Plugin {
  let cleanup: (() => Promise<void>) | undefined;
  return {
    name: "openapi-codegen",
    apply: "serve",
    async configureServer(server) {
      const { config, watcher } = server;
      const inputs = new Set(
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
      let pending = false;
      let stopped = false;
      let running: Promise<void> | undefined;
      const regenerate = () => {
        pending = true;
        running ??= (async () => {
          while (pending && !stopped) {
            pending = false;
            config.logger.info("Regenerating API clients...");
            try {
              await execFileAsync(
                process.versions.bun ? process.execPath : "bun",
                ["run", "openapi-ts"],
                {
                  cwd: config.root,
                  windowsHide: true,
                  maxBuffer: 10 * 1024 * 1024,
                },
              );
              for (const environment of Object.values(server.environments)) {
                environment.moduleGraph.invalidateAll();
              }
              server.ws.send({ type: "full-reload" });
            } catch (error) {
              if (!pending) {
                throw error;
              }
            }
          }
        })().finally(() => {
          running = undefined;
        });
        return running;
      };
      const onChange = (_event: string, file: string) => {
        if (stopped || !inputs.has(normalizePath(path.resolve(file)))) {
          return;
        }
        void regenerate().catch((error: Error) => {
          config.logger.error(error.message);
          server.ws.send({
            type: "error",
            err: { message: error.message, stack: error.stack ?? "" },
          });
        });
      };
      watcher.add([...inputs]);
      watcher.on("all", onChange);
      cleanup = async () => {
        stopped = true;
        watcher.off("all", onChange);
        await running?.catch(() => {});
      };
      try {
        await regenerate();
      } catch (error) {
        await server.close();
        throw error;
      }
    },
    async closeBundle() {
      await cleanup?.();
    },
  };
}
