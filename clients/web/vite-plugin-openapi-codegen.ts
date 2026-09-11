import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizePath, type Plugin } from "vite";

const execFileAsync = promisify(execFile);

export function openApiCodegenPlugin(): Plugin {
  return {
    name: "openapi-codegen",
    apply: "serve",
    async configResolved(config) {
      // Vite restarts when these inputs change, including during branch switches.
      config.configFileDependencies.push(
        ...[
          "../../assistant/openapi.yaml",
          "../../gateway/openapi.yaml",
          "openapi-schemas/platform.yaml",
          "openapi-schemas/auth.yaml",
          "openapi-ts.config.ts",
          "scripts/transform-daemon-spec.ts",
          "scripts/transform-gateway-spec.ts",
        ].map((input) => normalizePath(path.resolve(config.root, input))),
      );
      config.logger.info("Regenerating API clients...");
      await execFileAsync(
        process.versions.bun ? process.execPath : "bun",
        ["run", "openapi-ts"],
        { cwd: config.root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      );
    },
  };
}
