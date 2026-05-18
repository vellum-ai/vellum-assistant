import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SRC_DIR = path.resolve(import.meta.dirname, "src");

/**
 * Ensure a minimal client stub exists so that CI (which never runs
 * codegen) can still build. The stub lives in the gitignored
 * src/generated/api/ directory and is overwritten by real codegen.
 */
const generatedDir = path.join(SRC_DIR, "generated/api");
const clientStub = path.join(generatedDir, "client.gen.ts");
if (!fs.existsSync(clientStub)) {
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(
    clientStub,
    "export const client = { setConfig(_config: unknown) {} };\n",
  );
}

export default defineConfig({
  base: "/assistant",
  plugins: [tailwindcss(), react()],
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
