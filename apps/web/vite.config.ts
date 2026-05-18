import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/assistant/",
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@/": path.resolve(import.meta.dirname, "src") + "/",
    },
  },
  server: {
    port: 3001,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
