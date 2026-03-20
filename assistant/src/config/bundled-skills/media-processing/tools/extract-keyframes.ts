import { dirname, join } from "node:path";

import {
  getKeyframesForAsset,
  getMediaAssetById,
} from "../../../../memory/media-store.js";
import { getProviderKeyAsync } from "../../../../security/secure-keys.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  preprocessForAsset,
  type PreprocessOptions,
} from "../services/preprocess.js";

export { preprocessForAsset } from "../services/preprocess.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const includeAudio = Boolean(input.include_audio);
  const transcriptionMode =
    (input.transcription_mode as "api" | "local") || undefined;

  let openaiApiKey: string | undefined;
  if (includeAudio && (!transcriptionMode || transcriptionMode === "api")) {
    openaiApiKey = await getProviderKeyAsync("openai");
  }

  const options: PreprocessOptions = {
    intervalSeconds: (input.interval_seconds as number) || undefined,
    segmentDuration: (input.segment_duration as number) || undefined,
    deadTimeThreshold: (input.dead_time_threshold as number) || undefined,
    sectionConfigPath: (input.section_config as string) || undefined,
    detectDeadTime:
      input.detect_dead_time !== undefined
        ? Boolean(input.detect_dead_time)
        : undefined,
    shortEdge: (input.short_edge as number) || undefined,
    includeAudio,
    transcriptionMode,
    openaiApiKey,
  };

  try {
    const manifest = await preprocessForAsset(
      assetId,
      options,
      context.onOutput,
    );

    const asset = getMediaAssetById(assetId);
    const pipelineDir = join(dirname(asset!.filePath), "pipeline", assetId);
    const keyframes = getKeyframesForAsset(assetId);

    return {
      content: JSON.stringify(
        {
          message: `Preprocessed video: ${manifest.segments.length} segments, ${keyframes.length} keyframes`,
          assetId,
          segmentCount: manifest.segments.length,
          keyframeCount: keyframes.length,
          deadTimeRanges: manifest.deadTimeRanges.length,
          subjectGroups: manifest.subjectRegistry.groups.length,
          manifestPath: join(pipelineDir, "manifest.json"),
          config: manifest.config,
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (
      msg.startsWith("Media asset not found:") ||
      msg.startsWith("Preprocess requires a video asset.") ||
      msg.startsWith("Video asset has no duration") ||
      msg.startsWith("ffmpeg failed:") ||
      msg === "No frames were extracted from the video."
    ) {
      return { content: msg, isError: true };
    }
    return { content: `Preprocess failed: ${msg}`, isError: true };
  }
}
