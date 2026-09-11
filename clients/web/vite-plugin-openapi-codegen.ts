import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath, type Plugin, type ResolvedConfig } from "vite";

const execFileAsync = promisify(execFile);

export function openApiCodegenPlugin(): Plugin {
  let config: ResolvedConfig;
  let inputs: Set<string>;
  let pending = Promise.resolve();
  let stopWatching: (() => void) | undefined;
  const inputVersion = async () =>
    (
      await Promise.all(
        [...inputs].map(async (input) => {
          try {
            return createHash("sha256")
              .update(await readFile(input))
              .digest("hex");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return "missing";
            }
            throw error;
          }
        }),
      )
    ).join(":");
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
    configResolved(resolved) {
      config = resolved;
      inputs = new Set(
        [
          "../../assistant/openapi.yaml",
          "../../gateway/openapi.json",
          "openapi-schemas/platform.yaml",
          "openapi-schemas/auth.yaml",
          "openapi-ts.config.ts",
          "scripts/transform-daemon-spec.ts",
          "scripts/transform-gateway-spec.ts",
        ].map((input) => normalizePath(path.resolve(config.root, input))),
      );
    },
    async configureServer(server) {
      server.watcher.add([...inputs]);
      const schedule = () => {
        pending = pending.then(generate, generate).then(() => {
          server.moduleGraph.invalidateAll();
          server.ws.send({ type: "full-reload" });
        });
        void pending.catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          config.logger.error(message);
          server.ws.send({
            type: "error",
            err: { message, stack: "", plugin: "openapi-codegen" },
          });
        });
        return pending;
      };
      const changed = (event: string, file: string) => {
        if (
          inputs.has(normalizePath(file)) &&
          ["add", "change", "unlink"].includes(event)
        ) {
          schedule();
        }
      };
      server.watcher.on("all", changed);
      stopWatching = () => server.watcher.off("all", changed);
      try {
        let version = await inputVersion();
        let startup = schedule();
        for (;;) {
          await startup;
          const latest = await inputVersion();
          if (startup !== pending) {
            startup = pending;
          } else if (latest !== version) {
            startup = schedule();
          } else {
            break;
          }
          version = latest;
        }
      } catch (error) {
        await server.close();
        throw error;
      }
    },
    async closeBundle() {
      stopWatching?.();
      await pending.catch(() => {});
    },
  };
}
