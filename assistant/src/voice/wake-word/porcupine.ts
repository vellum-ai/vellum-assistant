/**
 * Picovoice Porcupine wake-word engine adapter.
 *
 * Wraps `@picovoice/porcupine-node` behind the {@link WakeWordDetector}
 * contract. The Node SDK is loaded lazily so the daemon does not pay the
 * native-binding cost for users who do not enable always-on voice.
 *
 * Audio format: 16 kHz, 16-bit signed PCM, mono. Frame length is fixed
 * by the SDK (`Porcupine.frameLength`, currently 512 samples = 32 ms).
 * The caller is responsible for resampling/chunking; see
 * {@link WakeWordFrameAccumulator} for a drop-in helper.
 */

import { getLogger } from "../../util/logger.js";
import type {
  WakeWordDetector,
  WakeWordEngineOptions,
  WakeWordEvent,
  WakeWordListener,
  WakeWordProviderId,
} from "./types.js";

const log = getLogger("wake-word:porcupine");

const PROVIDER_ID: WakeWordProviderId = "picovoice-porcupine";

const PORCUPINE_SAMPLE_RATE = 16_000;

/**
 * Minimal structural interface for the Picovoice Porcupine Node binding.
 * We re-declare it here so the daemon does not require
 * `@picovoice/porcupine-node` types at compile time — the SDK is
 * imported lazily and only when wake-word detection is actually
 * configured.
 */
interface PorcupineEngine {
  /** Returns the matched keyword index, or -1 when no wake fired. */
  process(pcm: Int16Array): number;
  release(): void;
  readonly frameLength: number;
  readonly sampleRate: number;
}

interface PorcupineModule {
  Porcupine: new (
    accessKey: string,
    keywordPaths: string[],
    sensitivities: number[],
    modelPath?: string,
  ) => PorcupineEngine;
  BuiltinKeyword: Record<string, string>;
}

/**
 * Lazy loader for the Porcupine Node SDK. Returned promise is cached so
 * repeated detector instantiations across the daemon only pay the load
 * cost once.
 */
let cachedModuleLoad: Promise<PorcupineModule> | null = null;
async function loadPorcupineModule(): Promise<PorcupineModule> {
  if (!cachedModuleLoad) {
    cachedModuleLoad = (async () => {
      try {
        // The Porcupine Node SDK is an optional runtime dependency — we
        // resolve it through a plain string variable so TypeScript does
        // not try to resolve the module at compile time. Users opt in
        // by running `bun add @picovoice/porcupine-node` once they
        // provision a Picovoice access key.
        const moduleName = "@picovoice/porcupine-node";
        const mod = (await import(moduleName)) as PorcupineModule;
        return mod;
      } catch (err) {
        cachedModuleLoad = null;
        throw new Error(
          `wake-word: failed to load @picovoice/porcupine-node — ` +
            `install it with 'bun add @picovoice/porcupine-node' to enable wake-word detection (${errorMessage(err)})`,
        );
      }
    })();
  }
  return cachedModuleLoad;
}

/**
 * Test/override hook — lets unit tests inject a stub Porcupine binding
 * without spawning the native module. The caller is responsible for
 * resetting via `setPorcupineModuleForTesting(null)` between tests.
 */
export function setPorcupineModuleForTesting(
  module: PorcupineModule | null,
): void {
  cachedModuleLoad = module ? Promise.resolve(module) : null;
}

export class PorcupineWakeWordDetector implements WakeWordDetector {
  readonly providerId = PROVIDER_ID;
  readonly sampleRate = PORCUPINE_SAMPLE_RATE;

  readonly keywordLabels: readonly string[];

  private readonly options: WakeWordEngineOptions;
  private engine: PorcupineEngine | null = null;
  private listener: WakeWordListener | null = null;
  private cachedFrameLength = 512;

  constructor(options: WakeWordEngineOptions) {
    if (options.keywords.length === 0) {
      throw new Error(
        "PorcupineWakeWordDetector requires at least one keyword",
      );
    }
    this.options = options;
    this.keywordLabels = options.keywords.map((k) => k.label);
  }

  get frameLength(): number {
    return this.engine?.frameLength ?? this.cachedFrameLength;
  }

  async start(onWake: WakeWordListener): Promise<void> {
    if (this.engine) {
      throw new Error("PorcupineWakeWordDetector.start() called twice");
    }

    const mod = await loadPorcupineModule();
    const keywordPaths: string[] = [];
    const sensitivities: number[] = [];

    for (const keyword of this.options.keywords) {
      sensitivities.push(clampSensitivity(keyword.sensitivity));
      if (keyword.source.kind === "builtin") {
        const builtinPath = resolveBuiltinKeywordPath(
          mod.BuiltinKeyword,
          keyword.source.keyword,
        );
        if (typeof builtinPath !== "string" || builtinPath.length === 0) {
          throw new Error(
            `PorcupineWakeWordDetector: built-in keyword '${keyword.source.keyword}' is not available in this Porcupine release`,
          );
        }
        keywordPaths.push(builtinPath);
      } else {
        keywordPaths.push(keyword.source.path);
      }
    }

    log.info(
      {
        keywords: this.keywordLabels,
        sampleRate: PORCUPINE_SAMPLE_RATE,
      },
      "Starting Porcupine wake-word detector",
    );

    this.engine = new mod.Porcupine(
      this.options.accessKey,
      keywordPaths,
      sensitivities,
      this.options.modelPath,
    );
    this.cachedFrameLength = this.engine.frameLength;
    this.listener = onWake;
  }

  processFrame(samples: Int16Array): number {
    const engine = this.engine;
    if (!engine) return -1;

    if (samples.length !== engine.frameLength) {
      throw new Error(
        `PorcupineWakeWordDetector.processFrame expected ${engine.frameLength} samples, received ${samples.length}`,
      );
    }

    const index = engine.process(samples);
    if (index < 0) return -1;

    const label = this.keywordLabels[index];
    const listener = this.listener;
    if (listener && label !== undefined) {
      const event: WakeWordEvent = {
        keywordIndex: index,
        keywordLabel: label,
        detectedAt: Date.now(),
      };
      try {
        listener(event);
      } catch (err) {
        log.warn(
          { err: errorMessage(err) },
          "Porcupine wake listener threw; swallowing to keep detector alive",
        );
      }
    }
    return index;
  }

  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.listener = null;
    if (!engine) return;
    try {
      engine.release();
    } catch (err) {
      log.warn(
        { err: errorMessage(err) },
        "Porcupine release() threw — best-effort shutdown",
      );
    }
  }
}

/**
 * Helper that batches arbitrary-sized PCM chunks into the engine's fixed
 * frame size. Most audio sources push 10–60 ms buffers; the engine
 * needs exactly `frameLength` samples per `process` call.
 *
 * Usage:
 *   const acc = new WakeWordFrameAccumulator(detector);
 *   acc.push(pcmFromMic);
 *   while (acc.hasFrame()) detector.processFrame(acc.takeFrame());
 *
 * Or simply call {@link feed} which does the loop internally.
 */
export class WakeWordFrameAccumulator {
  private readonly detector: WakeWordDetector;
  private buffer: Int16Array;
  private filled = 0;

  constructor(detector: WakeWordDetector) {
    this.detector = detector;
    this.buffer = new Int16Array(detector.frameLength);
  }

  /** Append a chunk of int16 PCM and process every complete frame. */
  feed(samples: Int16Array): void {
    let read = 0;
    while (read < samples.length) {
      const need = this.buffer.length - this.filled;
      const take = Math.min(need, samples.length - read);
      this.buffer.set(samples.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;
      if (this.filled === this.buffer.length) {
        this.detector.processFrame(this.buffer);
        this.filled = 0;
      }
    }
  }

  /** Drop any partially-buffered samples (e.g. on end-of-utterance). */
  reset(): void {
    this.filled = 0;
  }
}

function clampSensitivity(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveBuiltinKeywordPath(
  builtins: Record<string, string> | undefined,
  keyword: string,
): string | undefined {
  if (!builtins) return undefined;

  // Fast-path exact key lookups for SDKs that already expose lowercase names.
  const exact = builtins[keyword];
  if (typeof exact === "string" && exact.length > 0) return exact;

  // Porcupine keyword constants vary by SDK release (e.g. JARVIS, Jarvis,
  // "hey google", HEY_GOOGLE). Normalize both sides so we can resolve the
  // configured keyword robustly across naming styles.
  const normalized = normalizeBuiltinKeywordKey(keyword);
  for (const [key, path] of Object.entries(builtins)) {
    if (normalizeBuiltinKeywordKey(key) === normalized && path.length > 0) {
      return path;
    }
  }
  return undefined;
}

function normalizeBuiltinKeywordKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
