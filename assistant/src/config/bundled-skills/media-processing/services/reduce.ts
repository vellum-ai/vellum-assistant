/**
 * Reduce service - sends Map output to Claude as text-only for analysis.
 *
 * Two modes:
 * - One-shot merge: assembles all Map results into a single document,
 *   sends to Claude with the provided system prompt for analysis.
 * - Interactive Q&A: loads existing map output + user query, sends to
 *   Claude, returns the answer.
 *
 * Uses the existing provider infrastructure (getConfiguredProvider) so
 * it works with whatever LLM provider is configured.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMediaAssetById } from "../../../../memory/media-store.js";
import {
  createTimeout,
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../../../../providers/provider-send-message.js";
import type { MapOutput } from "./gemini-map.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReduceOptions {
  /** Natural language query about the video data. Optional for one-shot merge mode. */
  query?: string;
  /** Optional system prompt for Claude. */
  systemPrompt?: string;
  /** Model override. When omitted, the configured provider's default is used. */
  model?: string;
}

export interface ReduceResult {
  answer: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDUCE_TIMEOUT_MS = 120_000;

/**
 * Load map-output.json for an asset from its pipeline directory.
 */
async function loadMapOutput(assetId: string): Promise<MapOutput> {
  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  const pipelineDir = join(dirname(asset.filePath), "pipeline", assetId);
  const mapOutputPath = join(pipelineDir, "map-output.json");

  let raw: string;
  try {
    raw = await readFile(mapOutputPath, "utf-8");
  } catch {
    throw new Error(
      "No map output found. Run analyze_keyframes first to generate map-output.json.",
    );
  }

  return JSON.parse(raw) as MapOutput;
}

/**
 * Format map output segments into a text document for Claude.
 * Strips image data - text only.
 */
function formatMapOutputAsText(mapOutput: MapOutput): string {
  const lines: string[] = [];

  lines.push(`Video Analysis Data (asset: ${mapOutput.assetId})`);
  lines.push(`Model: ${mapOutput.model}`);
  lines.push(
    `Segments analyzed: ${mapOutput.successCount}/${mapOutput.segmentCount}`,
  );
  if (mapOutput.failedCount > 0) {
    lines.push(`Failed segments: ${mapOutput.failedCount}`);
  }
  if (mapOutput.skippedCount > 0) {
    lines.push(`Skipped segments: ${mapOutput.skippedCount}`);
  }
  lines.push("");
  lines.push("--- Segment Results ---");
  lines.push("");

  for (const segment of mapOutput.segments) {
    const startMin = Math.floor(segment.startSeconds / 60);
    const startSec = Math.floor(segment.startSeconds % 60);
    const endMin = Math.floor(segment.endSeconds / 60);
    const endSec = Math.floor(segment.endSeconds % 60);
    const timeRange = `${startMin}:${String(startSec).padStart(
      2,
      "0",
    )} - ${endMin}:${String(endSec).padStart(2, "0")}`;

    lines.push(`[Segment ${segment.segmentId}] ${timeRange}`);
    lines.push(JSON.stringify(segment.result, null, 2));
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reduce cost tracking
// ---------------------------------------------------------------------------

export interface ReduceCostEntry {
  query: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
}

export interface ReduceCostData {
  totalInputTokens: number;
  totalOutputTokens: number;
  entries: ReduceCostEntry[];
}

async function persistReduceCost(
  assetId: string,
  query: string,
  result: ReduceResult,
): Promise<void> {
  const asset = getMediaAssetById(assetId);
  if (!asset) return;

  const pipelineDir = join(dirname(asset.filePath), "pipeline", assetId);
  const costPath = join(pipelineDir, "reduce-cost.json");

  let existing: ReduceCostData = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    entries: [],
  };
  try {
    const raw = await readFile(costPath, "utf-8");
    existing = JSON.parse(raw) as ReduceCostData;
  } catch {
    // First query - start fresh
  }

  existing.entries.push({
    query,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    timestamp: new Date().toISOString(),
  });
  existing.totalInputTokens += result.inputTokens;
  existing.totalOutputTokens += result.outputTokens;

  await mkdir(pipelineDir, { recursive: true });
  await writeFile(costPath, JSON.stringify(existing, null, 2));
}

// ---------------------------------------------------------------------------
// Core: send to Claude via provider infrastructure
// ---------------------------------------------------------------------------

async function sendToClaude(
  mapText: string,
  query: string,
  systemPrompt?: string,
  model?: string,
  onProgress?: (msg: string) => void,
): Promise<ReduceResult> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new Error("No LLM provider available. Please configure an API key.");
  }

  const effectiveSystemPrompt =
    systemPrompt ??
    "You are an expert video analyst. You have been given structured analysis data extracted from a video. Answer the user's question based on this data. Be specific, reference timestamps when relevant, and provide clear, actionable insights.";

  const userContent = `Here is the video analysis data:\n\n${mapText}\n\n---\n\nUser query: ${query}`;

  onProgress?.("Sending map output to Claude for analysis...\n");

  const { signal, cleanup } = createTimeout(REDUCE_TIMEOUT_MS);

  try {
    const response = await provider.sendMessage(
      [userMessage(userContent)],
      [],
      effectiveSystemPrompt,
      {
        config: model ? { model } : {},
        signal,
      },
    );
    cleanup();

    const answer = extractAllText(response);

    onProgress?.(
      `Reduce complete (${response.usage.inputTokens} input + ${response.usage.outputTokens} output tokens).\n`,
    );

    return {
      answer,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One-shot merge mode: load map output for an asset, send all data to
 * Claude with a system prompt, and return the analysis.
 */
export async function reduceForAsset(
  assetId: string,
  options: ReduceOptions,
  onProgress?: (msg: string) => void,
): Promise<ReduceResult> {
  const mapOutput = await loadMapOutput(assetId);

  if (mapOutput.segments.length === 0) {
    throw new Error(
      "Map output contains no segments. Run analyze_keyframes first.",
    );
  }

  const mapText = formatMapOutputAsText(mapOutput);
  const effectiveQuery = options.query ?? "Summarize the video content.";
  const result = await sendToClaude(
    mapText,
    effectiveQuery,
    options.systemPrompt,
    options.model,
    onProgress,
  );
  try {
    await persistReduceCost(assetId, effectiveQuery, result);
  } catch {
    // Cost tracking is best-effort; don't discard the LLM result
  }
  return result;
}

/**
 * Interactive Q&A mode: load existing map output + user query, send to
 * Claude, return the answer. Functionally identical to reduceForAsset
 * but named distinctly for clarity in call sites.
 */
export async function queryMapOutput(
  assetId: string,
  options: ReduceOptions,
  onProgress?: (msg: string) => void,
): Promise<ReduceResult> {
  return reduceForAsset(assetId, options, onProgress);
}
