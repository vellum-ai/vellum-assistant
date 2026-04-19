import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { getConfig } from "../../config/loader.js";
import {
  generateImage,
  type ImageGenCredentials,
  mapGeminiError,
} from "../../media/gemini-image-service.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../../providers/managed-proxy/context.js";
import { getProviderKeyAsync } from "../../security/secure-keys.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// MIME type → file extension mapping
// ---------------------------------------------------------------------------

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

// ---------------------------------------------------------------------------
// MIME type from file extension (for source images)
// ---------------------------------------------------------------------------

function mimeForExtension(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerImageGenerationCommand(program: Command): void {
  const imageGen = program
    .command("image-generation")
    .description("AI image generation and editing");

  imageGen.addHelpText(
    "after",
    `
Modes:
  managed    — Uses platform-managed credentials (requires login to Vellum).
  your-own   — Uses your own Gemini API key configured in settings.

Supported models:
  gemini-3.1-flash-image-preview (default)
  gemini-3-pro-image-preview

Examples:
  $ assistant image-generation generate --prompt "A sunset over the ocean"
  $ assistant image-generation generate --prompt "Remove background" --mode edit --source photo.png
  $ assistant image-generation generate --prompt "Logo design" --variants 3 --output-dir ./output
  $ assistant image-generation generate --prompt "A cat" --json`,
  );

  const generate = imageGen
    .command("generate")
    .description("Generate or edit images using AI")
    .requiredOption(
      "--prompt <text>",
      "Description of the image to generate or edits to apply",
    )
    .option("--mode <mode>", "generate (default) or edit", "generate")
    .option(
      "--source <path...>",
      "Source image file path for edit mode (repeatable)",
    )
    .option("--model <model-id>", "Model override")
    .option(
      "--variants <n>",
      "Number of variants (1-4, default 1)",
      (v: string) => parseInt(v, 10),
      1,
    )
    .option("--output-dir <dir>", "Directory to save images")
    .option("--json", "Output structured JSON");

  generate.addHelpText(
    "after",
    `
Notes:
  Edit mode (--mode edit) requires at least one --source image file.
  Output files are named image-1.png, image-2.png, etc. (extension matches MIME type).
  Default output directory is the system temp directory.

Examples:
  $ assistant image-generation generate --prompt "A mountain landscape at dawn"
  $ assistant image-generation generate --prompt "Make it darker" --mode edit --source input.png
  $ assistant image-generation generate --prompt "Logo variations" --variants 4 --output-dir ./logos
  $ assistant image-generation generate --prompt "A robot" --model gemini-3-pro-image-preview --json`,
  );

  generate.action(async (opts) => {
    const jsonOutput = opts.json === true;
    const prompt: string = opts.prompt;
    const mode: "generate" | "edit" =
      opts.mode === "edit" ? "edit" : "generate";
    const sourcePaths: string[] | undefined = opts.source;
    const modelOverride: string | undefined = opts.model;
    const variants: number = Math.max(1, Math.min(opts.variants ?? 1, 4));
    const outputDir: string = opts.outputDir ?? os.tmpdir();

    // --- Resolve credentials ---
    const config = getConfig();
    const imageGenMode = config.services["image-generation"].mode;

    let credentials: ImageGenCredentials | undefined;

    if (imageGenMode === "managed") {
      const managedBaseUrl = await buildManagedBaseUrl("gemini");
      if (managedBaseUrl) {
        const ctx = await resolveManagedProxyContext();
        credentials = {
          type: "managed-proxy",
          assistantApiKey: ctx.assistantApiKey,
          baseUrl: managedBaseUrl,
        };
      }
    } else {
      const apiKey = await getProviderKeyAsync("gemini");
      if (apiKey) {
        credentials = { type: "direct", apiKey };
      }
    }

    if (!credentials) {
      const hint =
        imageGenMode === "managed"
          ? "Managed proxy is not available. Please log in to Vellum or switch to your-own mode:\n  Run 'assistant auth login' to authenticate, or set services.image-generation.mode to 'your-own' in config."
          : "No Gemini API key configured. Add your Gemini API key:\n  Run 'assistant keys set gemini' or configure it in Settings > Models & Services.";

      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ ok: false, error: hint }) + "\n");
      } else {
        log.error(hint);
      }
      process.exitCode = 1;
      return;
    }

    // --- Read source images for edit mode ---
    let sourceImages:
      | Array<{ mimeType: string; dataBase64: string }>
      | undefined;

    if (mode === "edit" && sourcePaths && sourcePaths.length > 0) {
      const errors: string[] = [];
      const validImages: Array<{ mimeType: string; dataBase64: string }> = [];

      for (const filePath of sourcePaths) {
        if (!existsSync(filePath)) {
          errors.push(`File not found: ${filePath}`);
          continue;
        }
        const file = Bun.file(filePath);
        const buffer = Buffer.from(await file.arrayBuffer());
        const mimeType =
          file.type !== "application/octet-stream"
            ? file.type
            : mimeForExtension(filePath);
        validImages.push({
          mimeType,
          dataBase64: buffer.toString("base64"),
        });
      }

      if (validImages.length === 0) {
        const errorMsg = `No source images could be read.\n${errors.join("\n")}`;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: errorMsg }) + "\n",
          );
        } else {
          log.error(errorMsg);
        }
        process.exitCode = 1;
        return;
      }
      sourceImages = validImages;
    }

    // --- Resolve model ---
    const model = modelOverride ?? config.services["image-generation"].model;

    // --- Generate image ---
    try {
      const result = await generateImage(credentials, {
        prompt,
        mode,
        sourceImages,
        model,
        variants,
      });

      // --- Ensure output directory exists ---
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // --- Write images to disk ---
      const imageOutputs: Array<{
        path: string;
        mimeType: string;
        sizeBytes: number;
      }> = [];

      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i];
        const ext = extensionForMime(img.mimeType);
        const fileName = `image-${i + 1}.${ext}`;
        const filePath = join(outputDir, fileName);
        const buffer = Buffer.from(img.dataBase64, "base64");
        writeFileSync(filePath, buffer);
        imageOutputs.push({
          path: filePath,
          mimeType: img.mimeType,
          sizeBytes: buffer.length,
        });
      }

      // --- Output ---
      if (jsonOutput) {
        const output: Record<string, unknown> = {
          images: imageOutputs,
          model: result.resolvedModel,
        };
        if (result.text) {
          output.text = result.text;
        }
        process.stdout.write(JSON.stringify(output) + "\n");
      } else {
        for (const img of imageOutputs) {
          process.stdout.write(img.path + "\n");
        }
      }
    } catch (error) {
      const errorMsg = mapGeminiError(error);
      if (jsonOutput) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: errorMsg }) + "\n",
        );
      } else {
        log.error(errorMsg);
      }
      process.exitCode = 1;
    }
  });
}
