import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/memory/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
