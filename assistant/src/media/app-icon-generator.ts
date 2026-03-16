/**
 * Generates app icons using the Gemini image generation service.
 *
 * Called as an async side-effect after app creation — never blocks
 * the main app_create flow. Icons are saved to the app's directory
 * as `icon.png` and included in .vellum bundles.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import { getAppsDir } from "../memory/app-store.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../providers/managed-proxy/context.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { getLogger } from "../util/logger.js";
import {
  generateImage,
  type ImageGenCredentials,
  mapGeminiError,
} from "./gemini-image-service.js";

const log = getLogger("app-icon-generator");

/**
 * Generate an app icon and save it to `~/.vellum/apps/{appId}/icon.png`.
 *
 * Uses Gemini image generation when an API key is available.
 * Silently no-ops if no key is configured or generation fails.
 */
export async function generateAppIcon(
  appId: string,
  appName: string,
  appDescription?: string,
): Promise<void> {
  const config = getConfig();
  const apiKey = await getProviderKeyAsync("gemini");

  let credentials: ImageGenCredentials | undefined;
  if (apiKey) {
    credentials = { type: "direct", apiKey };
  } else {
    const managedBaseUrl = await buildManagedBaseUrl("vertex");
    if (managedBaseUrl) {
      const ctx = await resolveManagedProxyContext();
      credentials = {
        type: "managed-proxy",
        assistantApiKey: ctx.assistantApiKey,
        baseUrl: managedBaseUrl,
      };
    }
  }

  if (!credentials) {
    log.debug(
      "No Gemini API key or managed proxy — skipping app icon generation",
    );
    return;
  }

  const appDir = join(getAppsDir(), appId);
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
    log.info({ appId, appName }, "Generating app icon via Gemini");

    const result = await generateImage(credentials, {
      prompt,
      mode: "generate",
      model: config.services["image-generation"].model,
    });

    if (result.images.length === 0) {
      log.warn({ appId }, "Gemini returned no image for app icon");
      return;
    }

    const image = result.images[0];
    const pngBuffer = Buffer.from(image.dataBase64, "base64");

    mkdirSync(appDir, { recursive: true });
    writeFileSync(iconPath, pngBuffer);

    log.info({ appId, iconPath }, "App icon saved");
  } catch (error) {
    const message = mapGeminiError(error);
    log.warn(
      { appId, error: message },
      "App icon generation failed — skipping",
    );
  }
}
