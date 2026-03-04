/**
 * Gemini Video service — uploads video directly to Gemini's Files API for
 * analysis, letting Gemini see actual motion and temporal context instead
 * of static keyframes.
 *
 * Uses @google/genai SDK directly (same as gemini-map.ts) to leverage
 * the Files API, responseMimeType, responseSchema, and usageMetadata.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError, GoogleGenAI } from "@google/genai";

import { computeRetryDelay, sleep } from "../../../../util/retry.js";
import { CostTracker } from "./cost-tracker.js";
import type { MapOutput, SegmentMapResult } from "./gemini-map.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeminiVideoOptions {
  apiKey: string;
  systemPrompt: string;
  outputSchema: Record<string, unknown>;
  context?: Record<string, unknown>;
  model?: string;
  maxRetries?: number;
}

// 2 GB file size limit for Gemini Files API
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

// Polling interval for file processing status (seconds)
const FILE_POLL_INTERVAL_MS = 2000;
const FILE_POLL_MAX_ATTEMPTS = 300; // 10 minutes max

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForFileActive(
  client: GoogleGenAI,
  fileName: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  for (let i = 0; i < FILE_POLL_MAX_ATTEMPTS; i++) {
    const fileInfo = await client.files.get({ name: fileName });
    if (fileInfo.state === "ACTIVE") {
      return;
    }
    if (fileInfo.state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${fileName}`);
    }
    if (i % 5 === 0) {
      onProgress?.(
        `  Waiting for Gemini to process video (state: ${fileInfo.state})...\n`,
      );
    }
    await sleep(FILE_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Gemini to process file ${fileName}`);
}

// ---------------------------------------------------------------------------
// Main: analyzeVideoDirectly
// ---------------------------------------------------------------------------

export async function analyzeVideoDirectly(
  assetId: string,
  pipelineDir: string,
  options: GeminiVideoOptions,
  filePath: string,
  durationSeconds: number,
  mimeType: string,
  onProgress?: (msg: string) => void,
): Promise<MapOutput> {
  const model = options.model ?? "gemini-2.5-flash";
  const maxRetries = options.maxRetries ?? 3;

  // Check file size before uploading
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Video file is ${(fileStat.size / (1024 * 1024 * 1024)).toFixed(
        1,
      )} GB, ` +
        `which exceeds Gemini's 2 GB file size limit. Use mode: 'keyframes' instead.`,
    );
  }

  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const costTracker = new CostTracker();

  await mkdir(pipelineDir, { recursive: true });

  onProgress?.(
    `Uploading video to Gemini Files API (${(
      fileStat.size /
      (1024 * 1024)
    ).toFixed(1)} MB)...\n`,
  );

  let uploadedFileName: string | undefined;

  try {
    // Upload the video file
    const uploadResult = await client.files.upload({
      file: filePath,
      config: { mimeType },
    });

    if (!uploadResult.name || !uploadResult.uri) {
      throw new Error("Gemini Files API upload returned no file name or URI");
    }

    uploadedFileName = uploadResult.name;
    onProgress?.(
      `Video uploaded: ${uploadResult.name}. Waiting for processing...\n`,
    );

    // Wait for file to be processed
    await waitForFileActive(client, uploadResult.name, onProgress);
    onProgress?.(`Video processed. Sending to ${model} for analysis...\n`);

    // Send to generateContent with retries
    let lastError: string | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let promptText = `Analyzing full video (${durationSeconds.toFixed(
          1,
        )}s duration).`;
        if (options.context) {
          promptText += `\n\nAdditional context:\n${JSON.stringify(
            options.context,
            null,
            2,
          )}`;
        }

        const response = await client.models.generateContent({
          model,
          contents: [
            {
              role: "user" as const,
              parts: [
                {
                  fileData: {
                    fileUri: uploadResult.uri,
                    mimeType: uploadResult.mimeType ?? mimeType,
                  },
                },
                { text: promptText },
              ] as never,
            },
          ],
          config: {
            systemInstruction: options.systemPrompt,
            responseMimeType: "application/json",
            responseSchema: options.outputSchema as never,
          },
        });

        const responseText = response.text ?? "{}";
        const parsed = JSON.parse(responseText);

        const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
        const responseModel = response.modelVersion ?? model;

        costTracker.record({
          segmentId: "full-video",
          model: responseModel,
          inputTokens,
          outputTokens,
        });

        // Build a single-segment MapOutput covering the full duration
        const segmentResult: SegmentMapResult = {
          segmentId: "full-video",
          startSeconds: 0,
          endSeconds: durationSeconds,
          result: parsed,
          model: responseModel,
          inputTokens,
          outputTokens,
        };

        const output: MapOutput = {
          assetId,
          model: responseModel,
          segmentCount: 1,
          successCount: 1,
          failedCount: 0,
          skippedCount: 0,
          costSummary: costTracker.getSummary(),
          segments: [segmentResult],
        };

        // Write output for compatibility with reduce/query pipeline
        const outputPath = join(pipelineDir, "map-output.json");
        await writeFile(outputPath, JSON.stringify(output, null, 2));

        onProgress?.(
          `Analysis complete (${inputTokens + outputTokens} tokens).\n`,
        );
        onProgress?.(
          `Cost: $${output.costSummary.totalEstimatedUSD.toFixed(
            4,
          )} (${inputTokens} input + ${outputTokens} output tokens).\n`,
        );

        return output;
      } catch (err) {
        if (err instanceof ApiError) {
          const message = err.message ?? "";

          // Safety blocks are not retryable
          if (message.includes("SAFETY") || message.includes("safety")) {
            throw new Error("Video was blocked by Gemini safety filter.");
          }

          // Non-retryable client errors
          if (
            err.status !== undefined &&
            err.status < 500 &&
            err.status !== 429
          ) {
            throw err;
          }

          // Retryable errors (429, 5xx)
          if (attempt < maxRetries) {
            const delay = computeRetryDelay(attempt);
            const reason =
              err.status === 429
                ? "rate limited"
                : `server error (${err.status})`;
            onProgress?.(
              `  ${reason}, retrying in ${Math.round(delay)}ms (attempt ${
                attempt + 1
              }/${maxRetries})...\n`,
            );
            await sleep(delay);
            continue;
          }
        }

        // Generic retry for unknown errors
        if (attempt < maxRetries) {
          const delay = computeRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(`Failed after ${maxRetries + 1} attempts: ${lastError}`);
  } finally {
    // Clean up uploaded file
    if (uploadedFileName) {
      try {
        await client.files.delete({ name: uploadedFileName });
        onProgress?.(`Cleaned up uploaded file from Gemini.\n`);
      } catch {
        // Best-effort cleanup — don't fail the operation
      }
    }
  }
}
