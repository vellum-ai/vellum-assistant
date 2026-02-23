import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../../../../config/defaults.js';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
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

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const analysisType = (input.analysis_type as string) || 'scene_description';
  const batchSize = (input.batch_size as number) || 10;

  if (batchSize <= 0) {
    return { content: 'batch_size must be greater than 0.', isError: true };
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Media asset not found: ${assetId}`, isError: true };
  }

  // Get all keyframes for this asset
  const keyframes = getKeyframesForAsset(assetId);
  if (keyframes.length === 0) {
    return {
      content: 'No keyframes found for this asset. Run extract_keyframes first.',
      isError: true,
    };
  }

  // Resumability: find already-analyzed keyframe IDs for this analysis type
  const existingOutputs = getVisionOutputsForAsset(assetId, analysisType);
  const analyzedKeyframeIds = new Set(existingOutputs.map((o) => o.keyframeId));
  const pendingKeyframes = keyframes.filter((kf) => !analyzedKeyframeIds.has(kf.id));

  if (pendingKeyframes.length === 0) {
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

  // Find or create the vision_analysis processing stage
  let stage: ProcessingStage | undefined;
  const existingStages = getProcessingStagesForAsset(assetId);
  stage = existingStages.find((s) => s.stage === 'vision_analysis');
  if (!stage) {
    stage = createProcessingStage({ assetId, stage: 'vision_analysis' });
  }

  updateProcessingStage(stage.id, { status: 'running', startedAt: Date.now() });

  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: 'Anthropic API key not configured',
    });
    return {
      content: 'No Anthropic API key available. Configure it in settings or set ANTHROPIC_API_KEY.',
      isError: true,
    };
  }

  const client = new Anthropic({ apiKey });
  let analyzedCount = analyzedKeyframeIds.size;
  const totalKeyframes = keyframes.length;
  let errorCount = 0;

  context.onOutput?.(`Analyzing ${pendingKeyframes.length} keyframes (${analyzedKeyframeIds.size} already done)...\n`);

  try {
    // Process in batches
    for (let i = 0; i < pendingKeyframes.length; i += batchSize) {
      if (context.signal?.aborted) {
        context.onOutput?.('Analysis cancelled.\n');
        break;
      }

      const batch = pendingKeyframes.slice(i, i + batchSize);
      const batchResults: Array<{
        assetId: string;
        keyframeId: string;
        analysisType: string;
        output: Record<string, unknown>;
        confidence?: number;
      }> = [];

      for (const keyframe of batch) {
        if (context.signal?.aborted) break;

        try {
          const result = await analyzeKeyframe(client, keyframe);
          batchResults.push({
            assetId,
            keyframeId: keyframe.id,
            analysisType,
            output: result.output,
            confidence: result.confidence,
          });
          analyzedCount++;
        } catch (err) {
          errorCount++;
          context.onOutput?.(`  Warning: failed to analyze frame at ${keyframe.timestamp}s: ${(err as Error).message}\n`);
        }
      }

      // Batch insert results
      if (batchResults.length > 0) {
        insertVisionOutputsBatch(batchResults);
      }

      // Update progress
      const progress = Math.round((analyzedCount / totalKeyframes) * 100);
      updateProcessingStage(stage.id, { progress });

      context.onOutput?.(`  Batch ${Math.floor(i / batchSize) + 1}: analyzed ${batchResults.length}/${batch.length} frames (${progress}% total)\n`);
    }

    const finalProgress = Math.round((analyzedCount / totalKeyframes) * 100);
    const isComplete = analyzedCount >= totalKeyframes;

    updateProcessingStage(stage.id, {
      status: isComplete ? 'completed' : 'running',
      progress: finalProgress,
      ...(isComplete ? { completedAt: Date.now() } : {}),
    });

    return {
      content: JSON.stringify({
        message: `Vision analysis ${isComplete ? 'completed' : 'in progress'}`,
        assetId,
        analysisType,
        totalKeyframes,
        analyzedCount,
        newlyAnalyzed: analyzedCount - analyzedKeyframeIds.size,
        errorCount,
        progress: finalProgress,
      }, null, 2),
      isError: false,
    };
  } catch (err) {
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: (err as Error).message.slice(0, 500),
    });
    return {
      content: `Vision analysis failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}

async function analyzeKeyframe(
  client: Anthropic,
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

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: base64,
            },
          },
          {
            type: 'text',
            text: VLM_PROMPT,
          },
        ],
      },
    ],
  });

  // Extract text from response
  const textBlock = response.content.find((block) => block.type === 'text');
  const responseText = textBlock && 'text' in textBlock ? textBlock.text : '';

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
