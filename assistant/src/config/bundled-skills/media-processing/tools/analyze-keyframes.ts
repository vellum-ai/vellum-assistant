import { readFile } from 'node:fs/promises';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { getAnthropicProvider, extractText, userMessageWithImage, userMessageWithImages } from '../../../../providers/anthropic-send-message.js';
import { initializeProviders } from '../../../../providers/registry.js';
import { loadConfig, invalidateConfigCache } from '../../../../config/loader.js';
import {
  getMediaAssetById,
  getKeyframesForAsset,
  getVisionOutputsForAsset,
  insertVisionOutputsBatch,
  createProcessingStage,
  updateProcessingStage,
  getProcessingStagesForAsset,
  type MediaKeyframe,
  type ProcessingStage,
} from '../../../../memory/media-store.js';

const VLM_PROMPT = `Analyze this image frame extracted from a video. Return a JSON object with the following fields:

{
  "sceneDescription": "A concise description of the overall scene",
  "subjects": ["List of identifiable subjects/objects/people in the frame"],
  "actions": ["List of actions or activities occurring"],
  "context": "Environmental or situational context (setting, conditions, etc.)"
}

Return ONLY the JSON object, no additional text.`;

const CHUNKED_VLM_PROMPT = `You are analyzing a sequence of {N} consecutive video frames extracted at regular intervals from a video. The frames are in chronological order.

For EACH frame, provide a JSON object with:
- "frameIndex": the 0-based index within this chunk
- "sceneDescription": concise description of the scene in this frame
- "subjects": array of identifiable subjects/objects/people
- "actions": array of actions or activities occurring
- "context": environmental or situational context
- "transitions": any notable changes from the previous frame (empty string for the first frame)

Return a JSON array of these objects, one per frame. Return ONLY the JSON array, no additional text.`;

function buildChunks(keyframes: MediaKeyframe[], chunkSize: number, overlap: number): MediaKeyframe[][] {
  const chunks: MediaKeyframe[][] = [];
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < keyframes.length; i += step) {
    chunks.push(keyframes.slice(i, i + chunkSize));
  }
  return chunks;
}

async function analyzeChunk(
  provider: import('../../../../providers/types.js').Provider,
  chunk: MediaKeyframe[],
): Promise<Array<{ keyframeId: string; output: Record<string, unknown>; confidence: number }>> {
  const images: Array<{ base64: string; mediaType: string }> = [];

  for (const keyframe of chunk) {
    const imageData = await readFile(keyframe.filePath);
    const base64 = imageData.toString('base64');
    const ext = keyframe.filePath.split('.').pop()?.toLowerCase() ?? 'jpg';
    const mediaTypeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    const mediaType = mediaTypeMap[ext] ?? 'image/jpeg';
    images.push({ base64, mediaType });
  }

  const prompt = CHUNKED_VLM_PROMPT.replace('{N}', String(chunk.length));

  const response = await provider.sendMessage(
    [userMessageWithImages(images, prompt)],
    undefined,
    undefined,
    {
      config: {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
      },
    },
  );

  const responseText = extractText(response);

  let parsed: Array<Record<string, unknown>>;
  try {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, responseText];
    parsed = JSON.parse(jsonMatch[1]!.trim()) as Array<Record<string, unknown>>;
  } catch {
    // If parsing fails, return a single entry wrapping the raw text
    parsed = chunk.map((_, idx) => ({
      frameIndex: idx,
      sceneDescription: idx === 0 ? responseText : '',
      subjects: [],
      actions: [],
      context: '',
      transitions: '',
    }));
  }

  return chunk.map((keyframe, idx) => {
    const entry = parsed[idx] ?? {
      frameIndex: idx,
      sceneDescription: '',
      subjects: [],
      actions: [],
      context: '',
      transitions: '',
    };
    // Add timestamp context
    entry.timestamp = keyframe.timestamp;
    return { keyframeId: keyframe.id, output: entry, confidence: 0.8 };
  });
}

export async function analyzeKeyframesForAsset(
  assetId: string,
  analysisType?: string,
  batchSize?: number,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  chunkSize?: number,
  overlap?: number,
): Promise<void> {
  const type = analysisType ?? 'scene_description';
  const batch = batchSize ?? 10;

  if (batch <= 0) {
    throw new Error('batch_size must be greater than 0.');
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  // Get all keyframes for this asset
  const keyframes = getKeyframesForAsset(assetId);
  if (keyframes.length === 0) {
    throw new Error('No keyframes found for this asset. Run extract_keyframes first.');
  }

  // Resumability: find already-analyzed keyframe IDs for this analysis type
  const existingOutputs = getVisionOutputsForAsset(assetId, type);
  const analyzedKeyframeIds = new Set(existingOutputs.map((o) => o.keyframeId));
  const pendingKeyframes = keyframes.filter((kf) => !analyzedKeyframeIds.has(kf.id));

  if (pendingKeyframes.length === 0) {
    // Nothing to do — all keyframes already analyzed
    return;
  }

  // Find or create the vision_analysis processing stage
  let stage: ProcessingStage | undefined;
  const existingStages = getProcessingStagesForAsset(assetId);
  stage = existingStages.find((s) => s.stage === 'vision_analysis');
  if (!stage) {
    stage = createProcessingStage({ assetId, stage: 'vision_analysis' });
  }

  updateProcessingStage(stage.id, { status: 'running', startedAt: Date.now() });

  // Use the same provider the main agent uses. If the provider registry
  // was cleared or not yet initialized, force-reload the config from
  // keychain/secure storage and re-initialize providers.
  let provider = getAnthropicProvider();
  if (!provider) {
    invalidateConfigCache();
    const freshConfig = loadConfig();
    if (freshConfig.apiKeys.anthropic) {
      initializeProviders(freshConfig);
      provider = getAnthropicProvider();
    }
  }
  if (!provider) {
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: 'Anthropic API key not configured',
    });
    throw new Error('No Anthropic API key available. Add one in Settings → Integrations.');
  }

  const effectiveChunkSize = chunkSize ?? 10;
  const effectiveOverlap = overlap ?? 2;

  let analyzedCount = analyzedKeyframeIds.size;
  const totalKeyframes = keyframes.length;

  const chunks = buildChunks(pendingKeyframes, effectiveChunkSize, effectiveOverlap);

  onProgress?.(`Analyzing ${pendingKeyframes.length} keyframes in ${chunks.length} chunks (${analyzedKeyframeIds.size} already done)...\n`);

  let aborted = false;

  try {
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      if (signal?.aborted) {
        onProgress?.('Aborted.\n');
        aborted = true;
        break;
      }

      const chunk = chunks[chunkIdx]!;

      try {
        const chunkResults = await analyzeChunk(provider, chunk);

        const batchResults: Array<{
          assetId: string;
          keyframeId: string;
          analysisType: string;
          output: Record<string, unknown>;
          confidence?: number;
        }> = [];

        for (const result of chunkResults) {
          // Overlap dedup: skip keyframes already inserted from a previous chunk
          if (analyzedKeyframeIds.has(result.keyframeId)) {
            continue;
          }
          analyzedKeyframeIds.add(result.keyframeId);
          analyzedCount++;
          batchResults.push({
            assetId,
            keyframeId: result.keyframeId,
            analysisType: type,
            output: result.output,
            confidence: result.confidence,
          });
        }

        if (batchResults.length > 0) {
          insertVisionOutputsBatch(batchResults);
        }
      } catch (err) {
        onProgress?.(`  Warning: failed to analyze chunk ${chunkIdx + 1}: ${(err as Error).message}\n`);
      }

      const progress = Math.round((analyzedCount / totalKeyframes) * 100);
      updateProcessingStage(stage.id, { progress });

      onProgress?.(`  Chunk ${chunkIdx + 1}/${chunks.length}: ${chunk.length} frames (${progress}% total)\n`);
    }

    if (aborted) {
      throw new Error('Analysis aborted');
    }

    const finalProgress = Math.round((analyzedCount / totalKeyframes) * 100);
    const isComplete = analyzedCount >= totalKeyframes;

    updateProcessingStage(stage.id, {
      status: isComplete ? 'completed' : 'running',
      progress: finalProgress,
      ...(isComplete ? { completedAt: Date.now() } : {}),
    });
  } catch (err) {
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: (err as Error).message.slice(0, 500),
    });
    throw err;
  }
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const analysisType = (input.analysis_type as string) || 'scene_description';
  const batchSize = (input.batch_size as number) ?? 10;
  const chunkSizeInput = (input.chunk_size as number) ?? 10;
  const overlapInput = (input.overlap as number) ?? 2;

  try {
    // Check if all keyframes are already analyzed before calling the core function
    const keyframes = getKeyframesForAsset(assetId);
    const existingOutputs = getVisionOutputsForAsset(assetId, analysisType);
    const analyzedKeyframeIds = new Set(existingOutputs.map((o) => o.keyframeId));
    const pendingKeyframes = keyframes.filter((kf) => !analyzedKeyframeIds.has(kf.id));

    if (keyframes.length > 0 && pendingKeyframes.length === 0) {
      return {
        content: JSON.stringify({
          message: 'All keyframes already analyzed',
          assetId,
          analysisType,
          totalKeyframes: keyframes.length,
          alreadyAnalyzed: existingOutputs.length,
        }, null, 2),
        isError: false,
      };
    }

    await analyzeKeyframesForAsset(assetId, analysisType, batchSize, context.onOutput, context.signal, chunkSizeInput, overlapInput);

    // Gather final stats
    const allKeyframes = getKeyframesForAsset(assetId);
    const allOutputs = getVisionOutputsForAsset(assetId, analysisType);
    const totalKeyframes = allKeyframes.length;
    const analyzedCount = allOutputs.length;
    const finalProgress = Math.round((analyzedCount / totalKeyframes) * 100);
    const isComplete = analyzedCount >= totalKeyframes;

    return {
      content: JSON.stringify({
        message: `Vision analysis ${isComplete ? 'completed' : 'in progress'}`,
        assetId,
        analysisType,
        totalKeyframes,
        analyzedCount,
        newlyAnalyzed: analyzedCount - analyzedKeyframeIds.size,
        errorCount: pendingKeyframes.length - (analyzedCount - analyzedKeyframeIds.size),
        progress: finalProgress,
      }, null, 2),
      isError: false,
    };
  } catch (err) {
    const msg = (err as Error).message;
    // Preserve original error message format
    if (
      msg === 'batch_size must be greater than 0.' ||
      msg.startsWith('Media asset not found:') ||
      msg === 'No keyframes found for this asset. Run extract_keyframes first.' ||
      msg === 'No Anthropic API key available. Add one in Settings → Integrations.'
    ) {
      return { content: msg, isError: true };
    }
    return { content: `Vision analysis failed: ${(err as Error).message}`, isError: true };
  }
}

async function analyzeKeyframe(
  provider: import('../../../../providers/types.js').Provider,
  keyframe: MediaKeyframe,
): Promise<{ output: Record<string, unknown>; confidence: number }> {
  // Read the image file and encode as base64
  const imageData = await readFile(keyframe.filePath);
  const base64 = imageData.toString('base64');

  // Determine media type from file extension
  const ext = keyframe.filePath.split('.').pop()?.toLowerCase() ?? 'jpg';
  const mediaTypeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const mediaType = mediaTypeMap[ext] ?? 'image/jpeg';

  const response = await provider.sendMessage(
    [userMessageWithImage(base64, mediaType, VLM_PROMPT)],
    undefined,
    undefined,
    {
      config: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
      },
    },
  );

  // Extract text from response
  const responseText = extractText(response);

  // Parse JSON from response
  let output: Record<string, unknown>;
  try {
    // Try to extract JSON from the response (handle markdown code fences)
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, responseText];
    output = JSON.parse(jsonMatch[1]!.trim()) as Record<string, unknown>;
  } catch {
    // If JSON parsing fails, wrap raw text as output
    output = {
      sceneDescription: responseText,
      subjects: [],
      actions: [],
      context: '',
    };
  }

  // Add timestamp context to the output
  output.timestamp = keyframe.timestamp;

  return { output, confidence: 0.8 };
}
