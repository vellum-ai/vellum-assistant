/**
 * Client-side wake-word detection using `@picovoice/porcupine-web`.
 *
 * The HUD owns the always-on mic stream and runs Porcupine in-process
 * inside the WebView so we don't have to ship raw audio to the daemon
 * 24/7. When wake fires, the HUD opens a live-voice WebSocket to the
 * gateway and starts forwarding 16 kHz PCM frames; the daemon-side
 * detector at `assistant/src/voice/wake-word/` exists for a future
 * server-side detection mode.
 *
 * Lazily imports the Picovoice SDK so the rest of the app still
 * type-checks without the access key configured.
 */

export interface WakeWordKeyword {
  readonly label: string;
  readonly source:
    | { readonly kind: "builtin"; readonly keyword: string }
    | { readonly kind: "file"; readonly path: string };
  readonly sensitivity: number;
}

export interface WakeWordClientOptions {
  readonly accessKey: string;
  readonly keywords: readonly WakeWordKeyword[];
  readonly modelPath?: string;
  readonly onWake: (label: string) => void;
  readonly onError?: (error: unknown) => void;
}

interface PorcupineWorkerModule {
  readonly PorcupineWorker: {
    create(
      accessKey: string,
      keywords: unknown,
      detectionCallback: (detection: { readonly label: string }) => void,
      model: { readonly publicPath: string },
    ): Promise<PorcupineWorkerInstance>;
  };
  readonly BuiltInKeyword: Record<string, unknown>;
}

interface PorcupineWorkerInstance {
  process(samples: Int16Array): Promise<void>;
  release(): Promise<void>;
}

const DEFAULT_MODEL_PATH = "/porcupine_params.pv";

let cachedPorcupineImport: Promise<PorcupineWorkerModule> | null = null;

async function loadPorcupineModule(): Promise<PorcupineWorkerModule> {
  if (cachedPorcupineImport) return cachedPorcupineImport;
  // String-literal dynamic import keeps the dependency optional — the
  // module is only needed when wake-word is enabled in config. We
  // launder through `unknown` because the published `.d.ts` ships a
  // richer surface than the small subset we exercise.
  cachedPorcupineImport = (
    import(/* @vite-ignore */ "@picovoice/porcupine-web") as Promise<unknown>
  ).then((mod) => mod as PorcupineWorkerModule);
  return cachedPorcupineImport;
}

export class WakeWordClient {
  private readonly options: WakeWordClientOptions;
  private worker: PorcupineWorkerInstance | null = null;
  private active = false;

  constructor(options: WakeWordClientOptions) {
    this.options = options;
  }

  isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (this.options.keywords.length === 0) {
      throw new Error("Wake-word client requires at least one keyword");
    }

    try {
      const mod = await loadPorcupineModule();
      const keywords = this.options.keywords.map((entry) => {
        if (entry.source.kind === "builtin") {
          const builtin = mod.BuiltInKeyword[normalizeBuiltinKey(entry.source.keyword)];
          if (!builtin) {
            throw new Error(
              `Unknown built-in Porcupine keyword: ${entry.source.keyword}`,
            );
          }
          return {
            builtin,
            label: entry.label,
            sensitivity: entry.sensitivity,
          };
        }
        return {
          publicPath: entry.source.path,
          label: entry.label,
          sensitivity: entry.sensitivity,
        };
      });

      this.worker = await mod.PorcupineWorker.create(
        this.options.accessKey,
        keywords,
        (detection) => {
          this.options.onWake(detection.label);
        },
        { publicPath: this.options.modelPath ?? DEFAULT_MODEL_PATH },
      );
      this.active = true;
    } catch (err) {
      this.options.onError?.(err);
      throw err;
    }
  }

  async pushFrame(samples: Int16Array): Promise<void> {
    if (!this.active || !this.worker) return;
    try {
      await this.worker.process(samples);
    } catch (err) {
      this.options.onError?.(err);
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      await this.worker?.release();
    } catch (err) {
      this.options.onError?.(err);
    }
    this.worker = null;
  }
}

function normalizeBuiltinKey(label: string): string {
  // Picovoice exports keys like "Jarvis", "HeySiri", "OkGoogle".
  return label
    .replace(/(?:^|\s|-)([a-z])/g, (_match, ch: string) => ch.toUpperCase())
    .replace(/\s+/g, "");
}
