import { cp } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const outdir = "dist";
if (existsSync(outdir)) rmSync(outdir, { recursive: true });
mkdirSync(outdir, { recursive: true });

// Build background + content scripts at the root of dist/, and the
// avatar tab script into dist/avatar/ so the manifest's
// `web_accessible_resources` entry + `avatar/avatar.html`'s relative
// `./avatar.js` `<script src>` can resolve.
const rootBuild = await Bun.build({
  entrypoints: ["src/background.ts", "src/content.ts"],
  outdir,
  target: "browser",
  format: "esm",
});
if (!rootBuild.success) {
  console.error(rootBuild.logs);
  process.exit(1);
}

mkdirSync(`${outdir}/avatar`, { recursive: true });
const avatarBuild = await Bun.build({
  entrypoints: ["src/avatar/avatar.ts"],
  outdir: `${outdir}/avatar`,
  target: "browser",
  format: "esm",
});
if (!avatarBuild.success) {
  console.error(avatarBuild.logs);
  process.exit(1);
}

await cp("manifest.json", `${outdir}/manifest.json`);
// Copy the avatar HTML + bundled GLB so the tab can load them via
// `chrome.runtime.getURL`.
await cp("avatar/avatar.html", `${outdir}/avatar/avatar.html`);
if (existsSync("avatar/default-avatar.glb")) {
  await cp("avatar/default-avatar.glb", `${outdir}/avatar/default-avatar.glb`);
}
console.log(`Built extension to ${outdir}/`);
