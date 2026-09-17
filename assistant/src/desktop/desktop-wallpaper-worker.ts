import { writeFile } from "node:fs/promises";

import { renderCurrentDesktopWallpaper } from "./desktop-wallpaper-renderer.js";

const [width, height, output] = process.argv.slice(2);
if (
  !output ||
  !Number.isFinite(Number(width)) ||
  !Number.isFinite(Number(height))
) {
  throw new Error("Wallpaper dimensions and output path are required");
}
const png = await renderCurrentDesktopWallpaper(Number(width), Number(height));
if (png) {
  await writeFile(output, png);
}
process.exit(0);
