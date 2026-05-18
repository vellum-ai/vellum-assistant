import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SRC_DIR = path.resolve(import.meta.dirname, "src");

/**
 * Stub unresolvable @/generated/* imports during build so that CI
 * (which never runs codegen) can still produce a valid bundle.
 * At runtime the app simply skips client configuration when the
 * generated module is absent — hooks that depend on the client
 * will fail gracefully with network errors until codegen is run.
 */
function stubGeneratedImports(): Plugin {
  const VIRTUAL_PREFIX = "\0stub-generated:";
  return {
    name: "stub-generated-imports",
    resolveId(id) {
      if (!id.startsWith("@/generated/")) return null;
      const realPath = path.join(SRC_DIR, id.slice(2)); // strip "@/"
      const candidates = [realPath, realPath.replace(/\.js$/, ".ts")];
      if (candidates.some((p) => fs.existsSync(p))) return null;
      return VIRTUAL_PREFIX + id;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      return "export const client = { setConfig() {} };";
    },
  };
}

export default defineConfig({
  base: "/assistant",
  plugins: [stubGeneratedImports(), tailwindcss(), react()],
  resolve: {
    alias: {
      "@/": SRC_DIR + "/",
    },
  },
  server: {
    port: 3001,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
