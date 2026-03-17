/**
 * Gemini Map service - processes video segments through Gemini's structured
 * output API for vision-based analysis with guaranteed valid JSON responses.
 *
 * Uses @google/genai SDK directly (not the GeminiProvider wrapper) to leverage
 * responseMimeType, responseSchema, and usageMetadata for cost tracking.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError, GoogleGenAI } from "@google/genai";

import { computeRetryDelay, sleep } from "../../../../util/retry.js";
import { ConcurrencyPool } from "./concurrency-pool.js";
import { type CostSummary, CostTracker } from "./cost-tracker.js";
import type { Segment } from "./preprocess.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeminiMapOptions {
  apiKey: string;
  systemPrompt: string;
  outputSchema: Record<string, unknown>;
  context?: Record<string, unknown>;
  model?: string;
  concurrency?: number;
  maxRetries?: number;
}

export interface SegmentMapResult {
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  result: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MapOutput {
  assetId: string;
  model: string;
  segmentCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  costSummary: CostSummary;
  segments: SegmentMapResult[];
}

type SegmentStatus = "success" | "failed" | "skipped";

interface SegmentProcessingResult {
  segmentId: string;
  status: SegmentStatus;
  result?: SegmentMapResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MEDIA_TYPE_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function inferMediaType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "jpg";
  return MEDIA_TYPE_MAP[ext] ?? "image/jpeg";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Hash the mapping configuration so cache keys change when the prompt, schema, or model changes. */
function computeConfigHash(options: GeminiMapOptions): string {
  const payload = JSON.stringify({
    systemPrompt: options.systemPrompt,
    outputSchema: options.outputSchema,
    model: options.model ?? "gemini-2.5-flash",
    context: options.context,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Core: process a single segment
// ---------------------------------------------------------------------------

async function processSegment(
  client: GoogleGenAI,
  segment: Segment,
  options: GeminiMapOptions,
): Promise<{
  result: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}> {
  // Read and encode frame images as base64 inline data parts
  const parts: Array<Record<string, unknown>> = [];

  for (const framePath of segment.framePaths) {
    const imageData = await readFile(framePath);
    const base64 = imageData.toString("base64");
    const mimeType = inferMediaType(framePath);
    parts.push({
      inlineData: { mimeType, data: base64 },
    });
  }

  // Add the text prompt part
  let promptText = `Analyzing ${segment.framePaths.length} frames from video segment ${segment.id} (${segment.startSeconds.toFixed(1)}s - ${segment.endSeconds.toFixed(1)}s).`;

  if (segment.transcript) {
    promptText += `\n\nAudio transcript for this segment:\n"""\n${segment.transcript}\n"""`;
  }

  if (options.context) {
    promptText += `\n\nAdditional context:\n${JSON.stringify(options.context, null, 2)}`;
  }

  parts.push({ text: promptText });

  const model = options.model ?? "gemini-2.5-flash";

  const response = await client.models.generateContent({
    model,
    contents: [{ role: "user" as const, parts: parts as never }],
    config: {
      systemInstruction: options.systemPrompt,
      responseMimeType: "application/json",
      responseSchema: options.outputSchema as never,
    },
  });

  // Extract response text (guaranteed JSON from responseMimeType)
  const responseText = response.text ?? "{}";
  const parsed = JSON.parse(responseText);

  // Extract token usage from usageMetadata
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  const responseModel = response.modelVersion ?? model;

  return { result: parsed, model: responseModel, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Process segment with retries
// ---------------------------------------------------------------------------

async function processSegmentWithRetry(
  client: GoogleGenAI,
  segment: Segment,
  options: GeminiMapOptions,
  maxRetries: number,
  onProgress?: (msg: string) => void,
): Promise<SegmentProcessingResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { result, model, inputTokens, outputTokens } = await processSegment(
        client,
        segment,
        options,
      );

      return {
        segmentId: segment.id,
        status: "success",
        result: {
          segmentId: segment.id,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          result,
          model,
          inputTokens,
          outputTokens,
        },
      };
    } catch (err) {
      // Handle Gemini safety blocks - not retryable
      if (err instanceof ApiError) {
        const message = err.message ?? "";
        if (message.includes("SAFETY") || message.includes("safety")) {
          onProgress?.(
            `  Segment ${segment.id}: blocked by safety filter, skipping.\n`,
          );
          return {
            segmentId: segment.id,
            status: "skipped",
            error: "Safety filter block",
          };
        }

        // Non-retryable client errors (400, 401, 403, etc.) - fail immediately
        if (
          err.status !== undefined &&
          err.status < 500 &&
          err.status !== 429
        ) {
          const errMsg = err.message ?? String(err);
          onProgress?.(
            `  Segment ${segment.id}: non-retryable error (${err.status}), skipping retries: ${errMsg}\n`,
          );
          return {
            segmentId: segment.id,
            status: "failed" as const,
            error: errMsg,
          };
        }

        // 429 rate limits - retryable with backoff
        if (err.status === 429 && attempt < maxRetries) {
          const delay = computeRetryDelay(attempt);
          onProgress?.(
            `  Segment ${segment.id}: rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...\n`,
          );
          await sleep(delay);
          continue;
        }

        // Other retryable errors (5xx)
        if (
          err.status !== undefined &&
          err.status >= 500 &&
          attempt < maxRetries
        ) {
          const delay = computeRetryDelay(attempt);
          onProgress?.(
            `  Segment ${segment.id}: server error (${err.status}), retrying in ${Math.round(delay)}ms...\n`,
          );
          await sleep(delay);
          continue;
        }
      }

      // Non-retryable or exhausted retries
      if (attempt === maxRetries) {
        const errMsg = err instanceof Error ? err.message : String(err);
        onProgress?.(
          `  Segment ${segment.id}: failed after ${maxRetries + 1} attempts: ${errMsg}\n`,
        );
        return { segmentId: segment.id, status: "failed", error: errMsg };
      }

      // Generic retry for unknown errors
      const delay = computeRetryDelay(attempt);
      await sleep(delay);
    }
  }

  // Should not reach here, but TypeScript needs a return
  return {
    segmentId: segment.id,
    status: "failed",
    error: "Exhausted retries",
  };
}

// ---------------------------------------------------------------------------
// Main: mapSegments
// ---------------------------------------------------------------------------

export async function mapSegments(
  assetId: string,
  pipelineDir: string,
  segments: Segment[],
  options: GeminiMapOptions,
  onProgress?: (msg: string) => void,
): Promise<MapOutput> {
  const model = options.model ?? "gemini-2.5-flash";
  const concurrency = options.concurrency ?? 10;
  const maxRetries = options.maxRetries ?? 3;

  const client = new GoogleGenAI({ apiKey: options.apiKey });
  const pool = new ConcurrencyPool(concurrency);
  const costTracker = new CostTracker();

  const mapResultsDir = join(pipelineDir, "map-results");
  await mkdir(mapResultsDir, { recursive: true });

  const configHash = computeConfigHash(options);

  const results: SegmentMapResult[] = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  onProgress?.(
    `Mapping ${segments.length} segments with ${model} (concurrency: ${concurrency})...\n`,
  );

  // Process all segments with concurrency limiting
  const promises = segments.map(async (segment) => {
    // Resumability: check for existing result file (keyed by segment + config + transcript hash)
    const segContentHash = createHash("sha256")
      .update(segment.transcript ?? "")
      .digest("hex")
      .slice(0, 8);
    const resultPath = join(
      mapResultsDir,
      `${segment.id}-${configHash}-${segContentHash}.json`,
    );
    if (await fileExists(resultPath)) {
      try {
        const existingData = await readFile(resultPath, "utf-8");
        const existing = JSON.parse(existingData) as SegmentMapResult;
        results.push(existing);
        successCount++;
        costTracker.record({
          segmentId: existing.segmentId,
          model: existing.model,
          inputTokens: existing.inputTokens,
          outputTokens: existing.outputTokens,
        });
        onProgress?.(`  Segment ${segment.id}: loaded from cache.\n`);
        return;
      } catch {
        // Corrupted cache file - reprocess
      }
    }

    await pool.acquire();
    try {
      const processingResult = await processSegmentWithRetry(
        client,
        segment,
        options,
        maxRetries,
        onProgress,
      );

      if (processingResult.status === "success" && processingResult.result) {
        const segResult = processingResult.result as SegmentMapResult;
        results.push(segResult);
        successCount++;

        costTracker.record({
          segmentId: segResult.segmentId,
          model: segResult.model,
          inputTokens: segResult.inputTokens,
          outputTokens: segResult.outputTokens,
        });

        // Write per-segment result to disk
        await writeFile(resultPath, JSON.stringify(segResult, null, 2));

        onProgress?.(
          `  Segment ${segment.id}: done (${segResult.inputTokens + segResult.outputTokens} tokens).\n`,
        );
      } else if (processingResult.status === "skipped") {
        skippedCount++;
      } else {
        failedCount++;
      }
    } finally {
      pool.release();
    }
  });

  await Promise.all(promises);

  // Sort results by segment start time
  results.sort((a, b) => a.startSeconds - b.startSeconds);

  // Write merged output
  const output: MapOutput = {
    assetId,
    model,
    segmentCount: segments.length,
    successCount,
    failedCount,
    skippedCount,
    costSummary: costTracker.getSummary(),
    segments: results,
  };

  const outputPath = join(pipelineDir, "map-output.json");
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  onProgress?.(
    `Map complete: ${successCount} succeeded, ${failedCount} failed, ${skippedCount} skipped.\n`,
  );
  onProgress?.(
    `Cost: $${output.costSummary.totalEstimatedUSD.toFixed(4)} (${output.costSummary.totalInputTokens} input + ${output.costSummary.totalOutputTokens} output tokens).\n`,
  );

  return output;
}
