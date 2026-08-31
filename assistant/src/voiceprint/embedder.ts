/**
 * Speaker embedding extraction.
 *
 * Runs ECAPA-TDNN (WeSpeaker's VoxCeleb large-margin model) over
 * Kaldi fbank features and returns a 192-dimensional L2-normalized
 * embedding. Two clips of the same speaker land close together under
 * cosine similarity; two speakers land far apart.
 *
 * This identifies, it does not authenticate. A voiceprint is not a
 * secret and cannot be presented as proof of identity, so nothing here
 * may feed an ACL decision. See `experimental/speaker-id/README.md`.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { getVoiceprintModelPath } from "../config/env-registry.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";
import { applyCmn, computeFbank, WESPEAKER_FBANK } from "./fbank.js";
import { runEmbeddingWorker } from "./voiceprint-worker.js";

const log = getLogger("voiceprint-embedder");

/**
 * Identifies which model produced an embedding. Embeddings from
 * different models are not comparable, so this is persisted alongside
 * every stored voiceprint and checked before scoring.
 */
export const VOICEPRINT_MODEL_ID = "wespeaker-ecapa-tdnn512-lm";

export const EMBEDDING_DIM = 192;

/** Shortest clip worth embedding. Below this the embedding is unstable. */
export const MIN_AUDIO_SECONDS = 1.5;

const MODEL_FILENAME = "ecapa-tdnn512-lm.onnx";
const MODEL_URL =
  "https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM/resolve/main/voxceleb_ECAPA512_LM.onnx";

export class AudioTooShortError extends Error {
  constructor(seconds: number) {
    super(
      `Clip is ${seconds.toFixed(2)}s; need at least ${MIN_AUDIO_SECONDS}s of audio to embed.`,
    );
    this.name = "AudioTooShortError";
  }
}

// ---------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------

/**
 * Resolve the ONNX weights, downloading them on first use.
 *
 * Whether the weights ship inside the image or are fetched at runtime
 * is still open (the fp32 export is 24.9 MB; an int8 quantization of it
 * is 6.4 MB). Keeping resolution behind one function means that
 * decision changes this file and nothing else.
 */
async function resolveModelPath(): Promise<string> {
  const override = getVoiceprintModelPath();
  if (override) {
    return override;
  }

  const cached = join(getDataDir(), "models", MODEL_FILENAME);
  try {
    await stat(cached);
    return cached;
  } catch {
    // Not cached yet.
  }

  log.info(
    { url: MODEL_URL, dest: cached },
    "Downloading speaker embedding model",
  );
  await mkdir(dirname(cached), { recursive: true });

  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download speaker model: HTTP ${response.status}`,
    );
  }
  // Download to a temp name and rename, so a partial download is never
  // mistaken for a cached model by the next call.
  const tmp = `${cached}.partial`;
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(tmp),
  );
  await rename(tmp, cached);
  log.info({ dest: cached }, "Speaker embedding model ready");
  return cached;
}

let modelPathPromise: Promise<string> | undefined;

/**
 * Resolve (and download) the weights once per process. The path is cached
 * rather than re-checked per request; the ONNX session itself lives in the
 * worker process and is created per spawn.
 */
function getModelPath(): Promise<string> {
  if (!modelPathPromise) {
    modelPathPromise = resolveModelPath().catch((err: unknown) => {
      // Do not cache a failed download; a later call should retry.
      modelPathPromise = undefined;
      throw err;
    });
  }
  return modelPathPromise;
}

/** Release the cached model path. Intended for tests. */
export function resetEmbedderForTests(): void {
  modelPathPromise = undefined;
}

// ---------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------

function l2Normalize(vec: Float32Array): Float32Array {
  let sumSquares = 0;
  for (const v of vec) {
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    throw new Error("Degenerate all-zero embedding");
  }
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i]! / norm;
  }
  return out;
}

/**
 * Compute the fbank features for one clip, validating its rate and length.
 */
function featuresFor(samples: Float32Array, sampleRate: number) {
  if (sampleRate !== WESPEAKER_FBANK.sampleRate) {
    throw new Error(
      `Expected ${WESPEAKER_FBANK.sampleRate} Hz audio, got ${sampleRate} Hz. Resample first.`,
    );
  }
  const seconds = samples.length / sampleRate;
  if (seconds < MIN_AUDIO_SECONDS) {
    throw new AudioTooShortError(seconds);
  }
  return applyCmn(computeFbank(samples));
}

/**
 * Extract L2-normalized speaker embeddings from several mono PCM clips.
 *
 * All clips share a single worker spawn, so enrolling N clips costs one
 * process start rather than N. Each `samples` must be normalized floats at
 * `WESPEAKER_FBANK.sampleRate`.
 */
export async function extractEmbeddings(
  clips: { samples: Float32Array; sampleRate: number }[],
): Promise<Float32Array[]> {
  if (clips.length === 0) {
    return [];
  }
  // Validate and featurize every clip before spawning, so a bad clip fails
  // fast instead of after the process start.
  const features = clips.map((c) => featuresFor(c.samples, c.sampleRate));
  const raw = await runEmbeddingWorker(features, await getModelPath());

  return raw.map((embedding) => {
    if (embedding.length !== EMBEDDING_DIM) {
      throw new Error(
        `Expected a ${EMBEDDING_DIM}-dim embedding, got ${embedding.length}`,
      );
    }
    return l2Normalize(embedding);
  });
}

/**
 * Extract an L2-normalized speaker embedding from mono PCM.
 *
 * `samples` must be normalized floats at `WESPEAKER_FBANK.sampleRate`.
 */
export async function extractEmbedding(
  samples: Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  const [embedding] = await extractEmbeddings([{ samples, sampleRate }]);
  return embedding!;
}

// ---------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------

/**
 * Cosine similarity between two L2-normalized embeddings, so a plain
 * dot product. Roughly [0, 1] in practice for this model.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

/**
 * Average several embeddings into one profile.
 *
 * Enrolling from more than one clip is the cheapest accuracy win
 * available: it averages away room, mic, and mood variation that any
 * single clip bakes in.
 */
export function averageEmbeddings(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) {
    throw new Error("Cannot average zero embeddings");
  }
  const dim = embeddings[0]!.length;
  const mean = new Float32Array(dim);
  for (const emb of embeddings) {
    if (emb.length !== dim) {
      throw new Error(`Embedding dimension mismatch: ${emb.length} vs ${dim}`);
    }
    for (let i = 0; i < dim; i++) {
      mean[i]! += emb[i]!;
    }
  }
  for (let i = 0; i < dim; i++) {
    mean[i]! /= embeddings.length;
  }
  return l2Normalize(mean);
}
