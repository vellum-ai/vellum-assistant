import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { imageGenerationHelp } from "./image-generation.help.js";

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
    name: imageGenerationHelp.name,
    transport: "ipc",
    description: imageGenerationHelp.description,
    build: (imageGen) => {
      applyCommandHelp(imageGen, imageGenerationHelp);

      const generate = subcommand(imageGen, "generate");

      generate.action(async (opts) => {
        const jsonOutput = opts.json === true;
        const prompt: string = opts.prompt;
        const mode: "generate" | "edit" =
          opts.mode === "edit" ? "edit" : "generate";
        const sourcePaths: string[] | undefined = opts.source;
        const modelOverride: string | undefined = opts.model;
        // --variants was declaratively registered without a parse function,
        // so a user-supplied value arrives as a string; coerce it here
        // (matching the previous parseInt argParser). The default stays 1.
        const rawVariants =
          typeof opts.variants === "string"
            ? parseInt(opts.variants, 10)
            : (opts.variants ?? 1);
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
