import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMediaAssetById } from "../../../../memory/media-store.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { type MapOutput, mapSegments } from "../services/gemini-map.js";
import { analyzeVideoDirectly } from "../services/gemini-video.js";
import type { PreprocessManifest } from "../services/preprocess.js";

// ---------------------------------------------------------------------------
// Exported function for job handler use
// ---------------------------------------------------------------------------

export interface MapSegmentsOptions {
  systemPrompt: string;
  outputSchema: Record<string, unknown>;
  context?: Record<string, unknown>;
  model?: string;
  concurrency?: number;
  maxRetries?: number;
}

export async function mapSegmentsForAsset(
  assetId: string,
  options: MapSegmentsOptions,
  onProgress?: (msg: string) => void,
): Promise<MapOutput> {
  const apiKey =
    (await getSecureKeyAsync("gemini")) ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "No Gemini API key configured. Please set your Gemini API key to use keyframe analysis.",
    );
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  // Load preprocess manifest
  const pipelineDir = join(dirname(asset.filePath), "pipeline", assetId);
  const manifestPath = join(pipelineDir, "manifest.json");

  let manifest: PreprocessManifest;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as PreprocessManifest;
  } catch {
    throw new Error(
      "No preprocess manifest found. Run extract_keyframes first.",
    );
  }

  if (manifest.segments.length === 0) {
    throw new Error(
      "No segments found in preprocess manifest. Run extract_keyframes first.",
    );
  }

  return mapSegments(
    assetId,
    pipelineDir,
    manifest.segments,
    {
      apiKey,
      systemPrompt: options.systemPrompt,
      outputSchema: options.outputSchema,
      context: options.context,
      model: options.model,
      concurrency: options.concurrency,
      maxRetries: options.maxRetries,
    },
    onProgress,
  );
}

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const systemPrompt = input.system_prompt as string | undefined;
  if (!systemPrompt) {
    return { content: "system_prompt is required.", isError: true };
  }

  const outputSchema = input.output_schema as
    | Record<string, unknown>
    | undefined;
  if (!outputSchema) {
    return { content: "output_schema is required.", isError: true };
  }

  const mode = (input.mode as string | undefined) ?? "keyframes";
  const contextObj = input.context as Record<string, unknown> | undefined;
  const model = input.model as string | undefined;
  const concurrency = input.concurrency as number | undefined;
  const maxRetries = input.max_retries as number | undefined;

  if (concurrency !== undefined && concurrency < 1) {
    return { content: "concurrency must be at least 1.", isError: true };
  }
  if (maxRetries !== undefined && maxRetries < 0) {
    return { content: "max_retries must be non-negative.", isError: true };
  }

  try {
    let output: MapOutput;

    if (mode === "direct_video") {
      const apiKey =
        (await getSecureKeyAsync("gemini")) ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return {
          content:
            "No Gemini API key configured. Please set your Gemini API key to use video analysis.",
          isError: true,
        };
      }

      const asset = getMediaAssetById(assetId);
      if (!asset) {
        return { content: `Media asset not found: ${assetId}`, isError: true };
      }
      if (asset.mediaType !== "video") {
        return {
          content: `Asset ${assetId} is not a video (type: ${asset.mediaType}). Direct video mode requires a video asset.`,
          isError: true,
        };
      }

      const pipelineDir = join(dirname(asset.filePath), "pipeline", assetId);

      output = await analyzeVideoDirectly(
        assetId,
        pipelineDir,
        {
          apiKey,
          systemPrompt,
          outputSchema,
          context: contextObj,
          model,
          maxRetries,
        },
        asset.filePath,
        asset.durationSeconds ?? 0,
        asset.mimeType,
        context.onOutput,
      );
    } else {
      output = await mapSegmentsForAsset(
        assetId,
        {
          systemPrompt,
          outputSchema,
          context: contextObj,
          model,
          concurrency,
          maxRetries,
        },
        context.onOutput,
      );
    }

    return {
      content: JSON.stringify(
        {
          message: `Map ${output.failedCount === 0 ? "completed" : "completed with errors"}`,
          assetId,
          mode,
          model: output.model,
          segmentCount: output.segmentCount,
          successCount: output.successCount,
          failedCount: output.failedCount,
          skippedCount: output.skippedCount,
          totalInputTokens: output.costSummary.totalInputTokens,
          totalOutputTokens: output.costSummary.totalOutputTokens,
          estimatedCostUSD: output.costSummary.totalEstimatedUSD,
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return { content: msg, isError: true };
  }
}
