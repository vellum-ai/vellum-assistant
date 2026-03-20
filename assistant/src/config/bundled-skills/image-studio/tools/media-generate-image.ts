import { getConfig } from "../../../../config/loader.js";
import {
  generateImage,
  type ImageGenCredentials,
  mapGeminiError,
} from "../../../../media/gemini-image-service.js";
import { getFilePathBySourcePath } from "../../../../memory/attachments-store.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "../../../../providers/managed-proxy/context.js";
import type { ImageContent } from "../../../../providers/types.js";
import { getProviderKeyAsync } from "../../../../security/secure-keys.js";
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
  const imageGenMode = config.services["image-generation"].mode;

  // Resolve credentials strictly based on mode — no cross-mode fallbacks
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
        ? "Managed proxy is not available. Please log in to Vellum or switch to Your Own mode."
        : "No Gemini API key configured. Please set your Gemini API key in Settings > Models & Services.";
    return { content: hint, isError: true };
  }

  const prompt = input.prompt as string;
  const mode = (input.mode as "generate" | "edit") ?? "generate";
  const sourcePaths = input.source_paths as string[] | undefined;
  const model =
    (input.model as string | undefined) ??
    config.services["image-generation"].model;
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
    const result = await generateImage(credentials, {
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
      content: mapGeminiError(error),
      isError: true,
    };
  }
}
