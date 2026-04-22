import { getConfig } from "../../../../config/loader.js";
import { resolveImageGenCredentials } from "../../../../media/image-credentials.js";
import {
  generateImage,
  mapImageGenError,
  providerForModel,
} from "../../../../media/image-service.js";
import { getFilePathBySourcePath } from "../../../../memory/attachments-store.js";
import type { ImageContent } from "../../../../providers/types.js";
import { sandboxPolicy } from "../../../../tools/shared/filesystem/path-policy.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const config = getConfig();
  const svc = config.services["image-generation"];
  const modelOverride = input.model as string | undefined;
  // Derive provider from the explicit model when supplied so that requesting
  // e.g. `gpt-image-2` while config.provider === "gemini" routes to OpenAI
  // instead of silently falling back to the Gemini default model.
  const provider = providerForModel(modelOverride, svc.provider);
  const { credentials, errorHint } = await resolveImageGenCredentials({
    provider,
    mode: svc.mode,
  });
  if (!credentials) {
    return {
      content: errorHint ?? "Image generation is not configured.",
      isError: true,
    };
  }

  const prompt = input.prompt as string;
  const mode = (input.mode as "generate" | "edit") ?? "generate";
  const sourcePaths = input.source_paths as string[] | undefined;
  const model = modelOverride ?? config.services["image-generation"].model;
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
    let content = `Generated ${imageCount} image${imageCount !== 1 ? "s" : ""} using ${result.resolvedModel}.`;
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
    return {
      content: mapImageGenError(provider, error),
      isError: true,
    };
  }
}
