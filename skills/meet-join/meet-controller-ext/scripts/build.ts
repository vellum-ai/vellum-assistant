import { cp } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const outdir = "dist";
if (existsSync(outdir)) rmSync(outdir, { recursive: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/content.ts"],
  outdir,
  target: "browser",
  format: "esm",
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
await cp("manifest.json", `${outdir}/manifest.json`);
console.log(`Built extension to ${outdir}/`);
