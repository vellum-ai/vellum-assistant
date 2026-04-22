/**
 * Generates app icons using the configured image-generation provider.
 *
 * Called as an async side-effect after app creation — never blocks
 * the main app_create flow. Icons are saved to the app's directory
 * as `icon.png` and included in .vellum bundles.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { getAppDirPath } from "../memory/app-store.js";
import { getLogger } from "../util/logger.js";
import { resolveImageGenCredentials } from "./image-credentials.js";
import { generateImage, mapImageGenError } from "./image-service.js";

const log = getLogger("app-icon-generator");

/**
 * Generate an app icon and save it to `~/.vellum/apps/{appId}/icon.png`.
 *
 * Uses the configured image-generation provider when credentials are
 * available. Silently no-ops if no credentials are configured or
 * generation fails.
 */
export async function generateAppIcon(
  appId: string,
  appName: string,
  appDescription?: string,
): Promise<void> {
  const config = getConfig();
  const svc = config.services["image-generation"];
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider: svc.provider,
    mode: svc.mode,
  });
  if (!credentials) {
    log.debug(
      `${errorHint ?? "Image generation is not configured"} — skipping app icon generation`,
    );
    return;
  }

  const appDir = getAppDirPath(appId);
  const iconPath = join(appDir, "icon.png");

  // Don't regenerate if icon already exists
  if (existsSync(iconPath)) {
    return;
  }

  const descPart = appDescription ? ` Description: ${appDescription}.` : "";

  const prompt =
    `Design a beautiful, minimal app icon for "${appName}".${descPart}\n\n` +
    "Style requirements:\n" +
    "- Square app icon with rounded corners (like macOS/iOS app icons)\n" +
    "- Clean, flat design with a single bold symbol or glyph in the center\n" +
    "- Rich gradient background using 2-3 harmonious colors\n" +
    "- The symbol should be white or very light colored for contrast\n" +
    "- No text, no letters, no words — only a symbolic glyph\n" +
    "- Professional quality, recognizable at small sizes (32px)\n" +
    "- Modern aesthetic similar to Apple's design language";

  try {
    log.info({ appId, appName, provider: svc.provider }, "Generating app icon");

    const result = await generateImage(svc.provider, credentials, {
      prompt,
      mode: "generate",
      model: svc.model,
    });

    if (result.images.length === 0) {
      log.warn(
        { appId, provider: svc.provider },
        "Provider returned no image for app icon",
      );
      return;
    }

    const image = result.images[0];
    const pngBuffer = Buffer.from(image.dataBase64, "base64");

    mkdirSync(appDir, { recursive: true });
    writeFileSync(iconPath, pngBuffer);

    log.info({ appId, iconPath }, "App icon saved");
  } catch (error) {
    const message = mapImageGenError(svc.provider, error);
    log.warn(
      { appId, provider: svc.provider, error: message },
      "App icon generation failed — skipping",
    );
  }
}
