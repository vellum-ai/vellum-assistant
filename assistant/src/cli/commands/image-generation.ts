import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
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
  registerCommand(program, {
    name: "image-generation",
    transport: "ipc",
    description: "AI image generation and editing",
    build: (imageGen) => {
      imageGen.addHelpText(
        "after",
        `
Modes:
  managed    — Uses platform-managed credentials (requires login to Vellum).
  your-own   — Uses your own Gemini or OpenAI API key depending on the configured model.

Supported models: pass a tier alias, the assistant resolves it to the
current model for that tier.
  fast     (default) quickest, good quality
  quality  higher fidelity, slower
  openai   OpenAI's model
A concrete model ID is also accepted; unknown values return an error
listing the currently available models.

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
  Uses your own Gemini or OpenAI API key depending on the configured model.

Examples:
  $ assistant image-generation generate --prompt "A mountain landscape at dawn"
  $ assistant image-generation generate --prompt "Make it darker" --mode edit --source input.png
  $ assistant image-generation generate --prompt "Logo variations" --variants 4 --output-dir ./logos
  $ assistant image-generation generate --prompt "A robot" --model quality --json
  $ assistant image-generation generate --prompt "A robot" --model openai --json`,
      );

      generate.action(async (opts) => {
        const jsonOutput = opts.json === true;
        const prompt: string = opts.prompt;
        const mode: "generate" | "edit" =
          opts.mode === "edit" ? "edit" : "generate";
        const sourcePaths: string[] | undefined = opts.source;
        const modelOverride: string | undefined = opts.model;
        const rawVariants = opts.variants ?? 1;
        const variants: number = Number.isNaN(rawVariants)
          ? 1
          : Math.max(1, Math.min(rawVariants, 4));
        const outputDir: string = opts.outputDir ?? os.tmpdir();

        // Validate edit mode requires --source
        if (mode === "edit" && (!sourcePaths || sourcePaths.length === 0)) {
          const msg = "Edit mode requires at least one --source image file.";
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Read source images from disk + base64-encode (stays in CLI)
        let sourceImages:
          | Array<{ mimeType: string; dataBase64: string }>
          | undefined;

        if (mode === "edit" && sourcePaths && sourcePaths.length > 0) {
          const errors: string[] = [];
          const validImages: Array<{ mimeType: string; dataBase64: string }> =
            [];

          for (const filePath of sourcePaths) {
            if (!existsSync(filePath)) {
              errors.push(`File not found: ${filePath}`);
              continue;
            }
            try {
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
            } catch (err) {
              errors.push(
                `Could not read ${filePath}: ${(err as Error).message}`,
              );
            }
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

        // Call daemon via IPC
        const r = await cliIpcCall<{
          images: Array<{
            mimeType: string;
            dataBase64: string;
            title?: string;
          }>;
          text?: string;
          resolvedModel: string;
        }>("image_generation_generate", {
          body: {
            prompt,
            mode,
            model: modelOverride,
            variants,
            ...(sourceImages && { sourceImages }),
          },
        });

        if (!r.ok)
          return exitFromIpcResult(
            { ok: false, error: r.error, statusCode: r.statusCode },
            generate,
          );

        // Write images to disk (stays in CLI)
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }

        const imageOutputs: Array<{
          path: string;
          mimeType: string;
          sizeBytes: number;
        }> = [];

        for (let i = 0; i < r.result!.images.length; i++) {
          const img = r.result!.images[i];
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

        // Output
        if (jsonOutput) {
          const output: Record<string, unknown> = {
            ok: true,
            images: imageOutputs,
            model: r.result!.resolvedModel,
          };
          if (r.result!.text) output.text = r.result!.text;
          process.stdout.write(JSON.stringify(output) + "\n");
        } else {
          for (const img of imageOutputs) {
            process.stdout.write(img.path + "\n");
          }
        }
      });
    },
  });
}
