import { join, dirname } from 'node:path';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import {
  getMediaAssetById,
  insertKeyframesBatch,
  deleteKeyframesForAsset,
  createProcessingStage,
  updateProcessingStage,
  getProcessingStagesForAsset,
  type ProcessingStage,
} from '../../../../memory/media-store.js';

const FFMPEG_TIMEOUT_MS = 300_000;

function spawnWithTimeout(
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${cmd[0]}`));
    }, timeoutMs);
    proc.exited.then(async (exitCode) => {
      clearTimeout(timer);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const intervalSeconds = (input.interval_seconds as number) || 3;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Media asset not found: ${assetId}`, isError: true };
  }

  if (asset.mediaType !== 'video') {
    return { content: `Keyframe extraction requires a video asset. Got: ${asset.mediaType}`, isError: true };
  }

  // Find or create the keyframe_extraction processing stage
  let stage: ProcessingStage | undefined;
  const existingStages = getProcessingStagesForAsset(assetId);
  stage = existingStages.find((s) => s.stage === 'keyframe_extraction');
  if (!stage) {
    stage = createProcessingStage({ assetId, stage: 'keyframe_extraction' });
  }

  updateProcessingStage(stage.id, { status: 'running', startedAt: Date.now() });

  // Store keyframes in a durable directory alongside the source file.
  // Extract to a temp dir first so that if ffmpeg fails the old frames remain intact.
  const outputDir = join(dirname(asset.filePath), 'keyframes', assetId);
  const tempDir = outputDir + '-tmp-' + randomUUID();
  await mkdir(tempDir, { recursive: true });

  try {
    context.onOutput?.(`Extracting keyframes every ${intervalSeconds}s from ${asset.title}...\n`);

    // Use ffmpeg to extract frames at the specified interval
    const result = await spawnWithTimeout([
      'ffmpeg', '-y',
      '-i', asset.filePath,
      '-vf', `fps=1/${intervalSeconds}`,
      '-q:v', '2',
      join(tempDir, 'frame-%06d.jpg'),
    ], FFMPEG_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      await rm(tempDir, { recursive: true, force: true });
      updateProcessingStage(stage.id, {
        status: 'failed',
        lastError: result.stderr.slice(0, 500),
      });
      return { content: `ffmpeg failed: ${result.stderr.slice(0, 500)}`, isError: true };
    }

    // List extracted frames
    const files = await readdir(tempDir);
    const frameFiles = files
      .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
      .sort();

    if (frameFiles.length === 0) {
      await rm(tempDir, { recursive: true, force: true });
      updateProcessingStage(stage.id, {
        status: 'failed',
        lastError: 'No frames extracted',
      });
      return { content: 'No frames were extracted from the video.', isError: true };
    }

    // Extraction succeeded — atomically swap temp dir into the durable path
    await rm(outputDir, { recursive: true, force: true });
    await rename(tempDir, outputDir);

    context.onOutput?.(`Extracted ${frameFiles.length} frames. Registering in database...\n`);

    // Build keyframe rows
    const keyframeRows = frameFiles.map((file, index) => ({
      assetId,
      timestamp: index * intervalSeconds,
      filePath: join(outputDir, file),
      metadata: { frameIndex: index, intervalSeconds },
    }));

    // Clear existing keyframes to prevent duplicates on re-extraction
    deleteKeyframesForAsset(assetId);

    // Batch insert
    const keyframes = insertKeyframesBatch(keyframeRows);

    // Update progress
    updateProcessingStage(stage.id, {
      status: 'completed',
      progress: 100,
      completedAt: Date.now(),
    });

    context.onOutput?.(`Registered ${keyframes.length} keyframes.\n`);

    return {
      content: JSON.stringify({
        message: `Extracted and registered ${keyframes.length} keyframes`,
        assetId,
        keyframeCount: keyframes.length,
        intervalSeconds,
        outputDir,
      }, null, 2),
      isError: false,
    };
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true });
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: (err as Error).message.slice(0, 500),
    });
    return {
      content: `Keyframe extraction failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
