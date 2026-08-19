import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  resolveImageGenCredentials,
  resolveImageGenRouting,
} from "../../../../media/image-credentials.js";
import {
  describeImageModels,
  resolveImageModel,
} from "../../../../media/image-models.js";
import {
  generateImage,
  mapImageGenError,
} from "../../../../media/image-service.js";
import { getFilePathBySourcePath } from "../../../../persistence/attachments-store.js";
import type { ImageContent } from "../../../../providers/types.js";
import { sandboxPolicy } from "../../../../tools/shared/filesystem/path-policy.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { getConfig } from "../../../loader.js";

/** Workspace-relative directory where generated images are saved. */
const GENERATED_MEDIA_DIR = "media/generated";

/**
 * Derive a filesystem-safe base name for a generated image from its title
 * (when the provider returns one) or the generation prompt.
 */
function imageFileSlug(title: string | undefined, prompt: string): string {
  const base = (title?.trim() || prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return base || "image";
}

/** Upper bound on filename-collision retries per image. */
const MAX_FILENAME_ATTEMPTS = 1000;

/**
 * Save generated images under `media/generated/` in the workspace so the
 * model can reference them by path (inline embeds, edit-mode iteration).
 * Each target path is validated through `sandboxPolicy` so a symlinked
 * directory cannot redirect the write outside the workspace, and files are
 * created exclusively (`wx`) so concurrent generations cannot claim the
 * same filename. Returns workspace-relative paths for the images written
 * before any failure; a failure stops the loop and is reported, not
 * thrown, so the inline content blocks still reach the model.
 */
function saveGeneratedImages(
  images: Array<{ mimeType: string; dataBase64: string; title?: string }>,
  prompt: string,
  workingDir: string,
): { savedPaths: string[]; saveError?: string } {
  const savedPaths: string[] = [];
  try {
    for (const img of images) {
      const ext = img.mimeType.split("/")[1] ?? "png";
      const slug = imageFileSlug(img.title, prompt);
      let written = false;
      for (let attempt = 1; attempt <= MAX_FILENAME_ATTEMPTS; attempt++) {
        const relPath =
          attempt === 1
            ? `${GENERATED_MEDIA_DIR}/${slug}.${ext}`
            : `${GENERATED_MEDIA_DIR}/${slug}-${attempt}.${ext}`;
        const pathCheck = sandboxPolicy(join(workingDir, relPath), workingDir, {
          mustExist: false,
        });
        if (!pathCheck.ok) {
          throw new Error(pathCheck.error);
        }
        mkdirSync(dirname(pathCheck.resolved), { recursive: true });
        try {
          writeFileSync(
            pathCheck.resolved,
            Buffer.from(img.dataBase64, "base64"),
            { flag: "wx" },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            continue;
          }
          throw error;
        }
        savedPaths.push(relPath);
        written = true;
        break;
      }
      if (!written) {
        throw new Error(
          `Could not find a free filename for "${slug}.${ext}" after ${MAX_FILENAME_ATTEMPTS} attempts.`,
        );
      }
    }
  } catch (error) {
    return { savedPaths, saveError: (error as Error).message };
  }
  return { savedPaths };
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const config = getConfig();
  const svc = config.services["image-generation"];
  let modelOverride = input.model;
  // Resolve tier aliases (fast, quality, openai) to concrete model IDs via
  // the registry. Unknown values get an error listing the current catalog so
  // callers can self-correct without a stale schema enum.
  if (typeof modelOverride === "string" && modelOverride) {
    const entry = resolveImageModel(modelOverride);
    if (!entry) {
      return {
        content: `Unknown model "${modelOverride}". Available models and aliases:\n${describeImageModels()}\n\nRetry with one of the aliases above, or omit the model parameter to use the configured default.`,
        isError: true,
      };
    }
    modelOverride = entry.id;
  }
  // Backend and managed-ness resolve together: an explicit model re-routes
  // to the model's backend (e.g. `gpt-image-2` under a gemini config routes
  // to OpenAI), and provider "vellum" runs managed with a model-derived
  // backend.
  const { backendProvider: provider, managed } = resolveImageGenRouting(
    svc,
    modelOverride,
  );
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider,
    managed,
  });
  if (!credentials) {
    return {
      content: `${errorHint ?? "Image generation is not configured."}\n\nReport this error to the user as-is. Do not change service configuration (managed/your-own mode or default provider/model settings) to try to fix it.`,
      isError: true,
    };
  }

  const prompt = input.prompt as string;
  const mode = (input.mode as "generate" | "edit") ?? "generate";
  const sourcePaths = input.source_paths as string[] | undefined;
  const model =
    typeof modelOverride === "string" && modelOverride
      ? modelOverride
      : config.services["image-generation"].model;
  const variants = input.variants as number | undefined;

  // Resolve source images from file paths (sandboxed to workingDir, edit mode only)
  let sourceImages: Array<{ mimeType: string; dataBase64: string }> | undefined;

  if (mode === "edit" && sourcePaths && sourcePaths.length > 0) {
    const errors: string[] = [];
    const validPathImages: Array<{ mimeType: string; dataBase64: string }> = [];
    for (const filePath of sourcePaths) {
      let resolvedPath: string;
      const pathCheck = sandboxPolicy(filePath, context.workingDir);
      if (!pathCheck.ok) {
        // Fallback: if the source path is outside the sandbox (e.g. an image
        // attached from ~/Desktop), check if the attachment store has a
        // workspace-internal copy stored under its original source_path.
        const storedPath = getFilePathBySourcePath(
          filePath,
          context.conversationId,
        );
        if (!storedPath) {
          errors.push(pathCheck.error);
          continue;
        }
        const fallbackCheck = sandboxPolicy(storedPath, context.workingDir);
        if (!fallbackCheck.ok) {
          errors.push(pathCheck.error);
          continue;
        }
        resolvedPath = fallbackCheck.resolved;
      } else {
        resolvedPath = pathCheck.resolved;
      }
      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) {
        errors.push(`File not found: ${filePath}`);
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      validPathImages.push({
        mimeType: file.type,
        dataBase64: buffer.toString("base64"),
      });
    }
    if (validPathImages.length === 0) {
      return {
        content: `None of the specified file paths could be read.\n${errors.join("\n")}`,
        isError: true,
      };
    }
    sourceImages = validPathImages;
  }

  try {
    const result = await generateImage(provider, credentials, {
      prompt,
      mode,
      sourceImages,
      model,
      variants,
    });

    const imageCount = result.images.length;
    const { savedPaths, saveError } = saveGeneratedImages(
      result.images,
      prompt,
      context.workingDir,
    );

    let content = `Generated ${imageCount} image${imageCount !== 1 ? "s" : ""} using ${result.resolvedModel}.`;
    if (savedPaths.length === 1) {
      content += ` Saved to ${savedPaths[0]}.`;
    } else if (savedPaths.length > 1) {
      content += ` Saved to:\n${savedPaths.map((p) => `- ${p}`).join("\n")}`;
    }
    if (savedPaths.length > 0) {
      content += `\n\nShow the user an image by embedding it in your reply: ![description](vellum://workspace/${savedPaths[0]}). To iterate on a result, pass its saved path via source_paths with mode "edit".`;
    }
    if (saveError) {
      content += `\n\nCould not save to the workspace (${saveError}); the image${imageCount !== 1 ? "s" : ""} will be attached to your reply automatically instead.`;
    }
    if (result.text) {
      content += `\n\n${result.text}`;
    }

    const contentBlocks: ImageContent[] = result.images.map((img) => {
      const block: ImageContent = {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mimeType,
          data: img.dataBase64,
        },
      };
      if (img.title) {
        (block as unknown as Record<string, unknown>)._title = img.title;
      }
      return block;
    });

    return {
      content,
      isError: false,
      contentBlocks,
    };
  } catch (error) {
    // Echo the model that failed so callers (including the skill's retry
    // branch) can key off the error text instead of remembering their input.
    return {
      content: `${mapImageGenError(provider, error)}\n\nFailed model: ${model}\n\nDo not change service configuration (managed/your-own mode or default provider/model settings) to try to fix it. Retrying this call once with a different model parameter is allowed; follow the skill's error handling instructions.`,
      isError: true,
    };
  }
}
