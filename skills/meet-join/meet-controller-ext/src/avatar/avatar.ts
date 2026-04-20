/**
 * Avatar tab entry point.
 *
 * Runs inside the pinned second Chrome tab the meet-bot's
 * `features/avatar.ts` opens. Its job:
 *
 * 1. Load TalkingHead.js (`@met4citizen/talkinghead`) and instantiate
 *    the bundled Ready Player Me GLB avatar. Operators can override
 *    the model by passing `?model=<url>` in the page URL — when
 *    absent we default to the bundled `default-avatar.glb`.
 *
 * 2. Listen for `avatar.push_viseme` messages via
 *    `chrome.runtime.onMessage` and drive TalkingHead.js's blend-shape
 *    weights from the viseme payload.
 *
 * 3. Start a per-frame `requestAnimationFrame` loop that captures the
 *    rendered canvas, encodes it as JPEG via `canvas.toBlob`, and
 *    posts the bytes back to the extension background service worker
 *    via `chrome.runtime.sendMessage`. The background forwards the
 *    frame over native messaging to the bot.
 *
 * 4. On bootstrap, post `{ type: "avatar.started" }` so the bot-side
 *    renderer's `start()` promise resolves with a bounded wait.
 *
 * ## Graceful degradation
 *
 * If TalkingHead.js fails to initialize (e.g. the bundled GLB is the
 * placeholder), we still post `avatar.started` so the bot doesn't hit
 * its `AvatarRendererUnavailableError` timeout. The canvas remains a
 * blank colored background and frames continue flowing — the bot's
 * camera stream shows a static background rather than going dark.
 * Operators can replace the placeholder GLB with a real Ready Player
 * Me model before a production rollout; see `avatar/README.md`.
 *
 * ## Capture strategy
 *
 * We use `canvas.toBlob("image/jpeg", 0.8)` inside a 1/targetFps
 * `requestAnimationFrame` loop. This is the simpler of the two
 * strategies outlined in the plan:
 *
 *   - **JPEG toBlob**: lossy but portable, one encoded blob per
 *     frame. Requires ffmpeg on the bot side to transcode to Y4M
 *     before writing to `/dev/video10`. v1 uses this path.
 *   - **`canvas.captureStream()` → MediaRecorder**: produces a
 *     continuous Y4M-compatible stream without ffmpeg but requires
 *     more plumbing (MediaRecorder → Blob chunks → base64 → NMH).
 *     Future work.
 *
 * JPEG is sufficient for 20–24 fps avatar video and avoids adding a
 * full media-stream pipeline for v1.
 */

import type {
  BotToExtensionMessage,
  ExtensionAvatarFrameMessage,
  ExtensionAvatarStartedMessage,
} from "../../../contracts/native-messaging.js";
import { AVATAR_GLB_MIN_SIZE_BYTES } from "../../../contracts/native-messaging.js";

/** Default capture cadence the avatar loop targets. */
const DEFAULT_TARGET_FPS = 24;

/** JPEG quality factor — low enough to keep frames under 100 KB. */
const JPEG_QUALITY = 0.8;

/** Width/height we render the canvas at. Matches avatar.html styling. */
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

/**
 * Narrow slice of the TalkingHead.js API we actually drive. Kept
 * permissive so we don't depend on the exact npm type definitions
 * (which evolve across versions). TalkingHead.js ships as a plain
 * module that exports a class with these core methods.
 */
interface TalkingHeadInstance {
  showAvatar?(opts: { url: string }): Promise<void>;
  setMood?(mood: string): void;
  /**
   * Directly drive a mouth-shape blend-weight. Implementations vary;
   * we pass the raw phoneme label + weight and let TalkingHead.js
   * decide which morph target to target.
   */
  speakMorph?(phoneme: string, weight: number): void;
}

/**
 * Narrow slice of the TalkingHead.js constructor. We load the module
 * dynamically so the avatar page works even when the module isn't
 * present (placeholder path / unit tests) — we just log and fall
 * back to a static canvas.
 */
interface TalkingHeadConstructor {
  new (el: HTMLElement, opts?: Record<string, unknown>): TalkingHeadInstance;
}

/**
 * Attempt to load TalkingHead.js at runtime. Returns `null` if the
 * module isn't available (e.g. the bundled vendor copy was skipped
 * because the placeholder GLB is in use).
 *
 * The dynamic `import()` is wrapped in a try/catch so a missing
 * module doesn't crash the avatar page — we still want to emit
 * `avatar.started` and a stream of (blank) frames so the bot's
 * renderer remains healthy.
 */
async function loadTalkingHeadCtor(): Promise<TalkingHeadConstructor | null> {
  try {
    // `@met4citizen/talkinghead` exports its class as `TalkingHead`.
    // Using a string literal lets the bundler keep this as a dynamic
    // import so a build-time failure doesn't prevent the avatar page
    // from rendering the placeholder. The module doesn't ship type
    // declarations, so we cast through `unknown` to keep TypeScript
    // happy — the module's runtime shape matches our structural
    // narrow above.
    const specifier = "@met4citizen/talkinghead";
    const mod = (await import(
      /* @vite-ignore */ specifier as string
    )) as unknown as {
      TalkingHead?: TalkingHeadConstructor;
      default?: TalkingHeadConstructor;
    };
    return mod.TalkingHead ?? mod.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate the GLB URL to load. When `?model=<url>` is on the page
 * URL we use the supplied URL; otherwise we fall back to the bundled
 * `default-avatar.glb` resolved via `chrome.runtime.getURL`.
 */
function resolveModelUrl(): string {
  const params = new URLSearchParams(location.search);
  const override = params.get("model");
  if (override) return override;
  return chrome.runtime.getURL("avatar/default-avatar.glb");
}

/**
 * Render-loop context. Keeps the active canvas and the TalkingHead.js
 * instance so the viseme handler and capture loop share state.
 *
 * `glbProbe` is the result of fetching the resolved GLB at boot — the
 * `avatar.started` ack carries this through to the bot so the bot-side
 * renderer can fail fast when the bundled placeholder is still in use
 * instead of silently emitting a blank video stream. See
 * `avatar/README.md` for the operator replacement procedure.
 */
interface AvatarContext {
  canvas: HTMLCanvasElement;
  head: TalkingHeadInstance | null;
  targetFps: number;
  glbProbe: GlbProbeResult;
}

/**
 * Outcome of fetching the resolved GLB URL at boot time. Used only to
 * annotate the `avatar.started` ack so the bot can detect the
 * 0-byte-placeholder case and surface a clear operator error.
 *
 * `size` is `0` when the fetch failed outright (network error, 4xx,
 * etc.) — a failed fetch is treated as a placeholder signal because
 * TalkingHead.js will also fail to load the model in that case.
 */
interface GlbProbeResult {
  placeholderDetected: boolean;
  size: number;
}

/**
 * Fetch the resolved GLB URL and check its byte size. Returns a
 * best-effort signal the avatar tab attaches to `avatar.started` so
 * the bot can fail fast when the bundled placeholder
 * (`default-avatar.glb` — committed as a 0-byte stub) is still in
 * place. Any fetch error is reported as `placeholderDetected: true,
 * size: 0` because a GLB the tab can't even retrieve will not render.
 */
async function probeGlb(modelUrl: string): Promise<GlbProbeResult> {
  try {
    const response = await fetch(modelUrl);
    if (!response.ok) {
      return { placeholderDetected: true, size: 0 };
    }
    const blob = await response.blob();
    return {
      placeholderDetected: blob.size < AVATAR_GLB_MIN_SIZE_BYTES,
      size: blob.size,
    };
  } catch (err) {
    console.warn("[avatar-tab] GLB probe fetch failed:", err);
    return { placeholderDetected: true, size: 0 };
  }
}

/**
 * Initialize the avatar page. Creates a canvas inside `#avatar-root`,
 * loads TalkingHead.js (best-effort), and resolves the bundled GLB
 * URL. Returns the shared context used by the viseme listener and
 * the capture loop.
 */
async function bootAvatar(): Promise<AvatarContext> {
  const root = document.getElementById("avatar-root");
  if (!root) {
    throw new Error("avatar-root element missing from avatar.html");
  }

  // Replace the placeholder status text with the actual canvas. The
  // status element is retained as a sibling so TalkingHead.js has a
  // plain container to mount its three.js renderer into.
  const statusEl = document.getElementById("avatar-status");
  if (statusEl) statusEl.remove();

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  root.appendChild(canvas);

  // Fill the canvas with a neutral background up-front so early
  // frames (before TalkingHead.js finishes loading) don't stream a
  // transparent/black frame that Chrome's camera encoder may drop.
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  const modelUrl = resolveModelUrl();

  // Probe the GLB before attempting TalkingHead.js init so the ack
  // carries a reliable placeholder signal back to the bot even when
  // the module load below succeeds but the render ultimately fails.
  // Running the probe in parallel with the module load keeps boot
  // latency unchanged when the GLB is valid.
  const [TalkingHeadCtor, glbProbe] = await Promise.all([
    loadTalkingHeadCtor(),
    probeGlb(modelUrl),
  ]);

  let head: TalkingHeadInstance | null = null;
  if (TalkingHeadCtor) {
    try {
      head = new TalkingHeadCtor(canvas, {
        modelRoot: modelUrl.replace(/\/[^/]+$/, "/"),
        cameraView: "upper",
      });
      await head.showAvatar?.({ url: modelUrl });
    } catch (err) {
      // A failed load is recoverable — we keep the static canvas and
      // continue emitting blank frames so the bot sees the camera
      // stream as active.
      console.warn("[avatar-tab] talkinghead init failed:", err);
      head = null;
    }
  } else {
    console.warn("[avatar-tab] @met4citizen/talkinghead module not available");
  }

  return {
    canvas,
    head,
    targetFps: DEFAULT_TARGET_FPS,
    glbProbe,
  };
}

/**
 * Handle an inbound `avatar.push_viseme` from the extension
 * background. Drives TalkingHead.js's mouth blend-shape when a
 * TalkingHead.js instance is available; logs and drops otherwise.
 */
function handleViseme(
  ctx: AvatarContext,
  msg: { phoneme: string; weight: number; timestamp: number },
): void {
  if (!ctx.head) return;
  try {
    ctx.head.speakMorph?.(msg.phoneme, msg.weight);
  } catch (err) {
    console.warn("[avatar-tab] speakMorph failed:", err);
  }
}

/**
 * Start a capture loop that grabs the canvas as JPEG at the target
 * cadence and posts the bytes back to the extension background. The
 * background forwards the frame over native messaging to the bot.
 *
 * Uses `requestAnimationFrame` as the timer so the loop pauses when
 * Chrome decides the tab isn't visible. We counter Chrome's
 * tab-backgrounding by (a) opening the tab `pinned: true` (in
 * `features/avatar.ts`) and (b) keeping the render loop cheap so it
 * budgets cleanly. A future PR may add a visibility-change
 * watchdog that re-activates the tab if Chrome freezes it.
 */
function startCaptureLoop(ctx: AvatarContext): () => void {
  let running = true;
  let lastEmitTs = 0;

  const minInterval = Math.floor(1000 / ctx.targetFps);

  const emitFrame = async (): Promise<void> => {
    if (!running) return;
    const now = performance.now();
    if (now - lastEmitTs < minInterval) return;
    lastEmitTs = now;

    const blob: Blob | null = await new Promise((resolve) =>
      ctx.canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!running || !blob) return;

    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const base64 = encodeBase64(bytes);

    const msg: ExtensionAvatarFrameMessage = {
      type: "avatar.frame",
      bytes: base64,
      width: ctx.canvas.width,
      height: ctx.canvas.height,
      format: "jpeg",
      ts: now,
    };
    try {
      void chrome.runtime.sendMessage(msg);
    } catch (err) {
      console.warn("[avatar-tab] sendMessage for avatar.frame failed:", err);
    }
  };

  const tick = (): void => {
    if (!running) return;
    void emitFrame();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return () => {
    running = false;
  };
}

/** Base64-encode a Uint8Array. Avoids bringing in a base64 library. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Wire the runtime-message listener so the avatar tab responds to
 * `avatar.push_viseme` from the extension background. The type guard
 * is defensive: the background only sends `avatar.push_viseme` to
 * the avatar tab, but a message from any other origin should be
 * ignored.
 */
function installVisemeListener(ctx: AvatarContext): void {
  chrome.runtime.onMessage.addListener(
    (raw, _sender, _sendResponse): boolean => {
      if (!raw || typeof raw !== "object") return false;
      const msg = raw as BotToExtensionMessage;
      if (msg.type !== "avatar.push_viseme") return false;
      handleViseme(ctx, {
        phoneme: msg.phoneme,
        weight: msg.weight,
        timestamp: msg.timestamp,
      });
      return false;
    },
  );
}

/**
 * Bootstrap entry point. Any unhandled error is caught and logged —
 * we never throw into the page runtime because the only thing that
 * would do is kill the tab and leave the bot stuck waiting for the
 * `avatar.started` ack.
 *
 * The ack carries `placeholderDetected` when the GLB probe observed a
 * sub-threshold file (the repo's bundled `default-avatar.glb` is a
 * 0-byte stub operators must replace). The bot-side renderer's
 * `start()` inspects the flag and throws
 * `AvatarRendererUnavailableError` so the session-manager can fall
 * back to the noop renderer with a clear diagnostic instead of
 * silently streaming a blank camera feed.
 */
async function main(): Promise<void> {
  let ctx: AvatarContext;
  try {
    ctx = await bootAvatar();
  } catch (err) {
    console.error("[avatar-tab] bootAvatar failed:", err);
    // bootAvatar never had a chance to probe the GLB. Treat this path
    // as placeholder-equivalent so the bot fails fast with a clear
    // pointer to the README rather than sitting on a static canvas.
    const ack: ExtensionAvatarStartedMessage = {
      type: "avatar.started",
      placeholderDetected: true,
      glbSize: 0,
    };
    try {
      void chrome.runtime.sendMessage(ack);
    } catch {
      // Best-effort.
    }
    return;
  }

  installVisemeListener(ctx);
  startCaptureLoop(ctx);

  // Handshake: the bot's renderer awaits this ack before resolving
  // start(). `placeholderDetected` is only attached when the probe
  // actually flagged the GLB — omitting it keeps the wire payload
  // compatible with older contract builds that don't know the field.
  const ack: ExtensionAvatarStartedMessage = { type: "avatar.started" };
  if (ctx.glbProbe.placeholderDetected) {
    ack.placeholderDetected = true;
    ack.glbSize = ctx.glbProbe.size;
  }
  try {
    void chrome.runtime.sendMessage(ack);
  } catch (err) {
    console.warn("[avatar-tab] failed to send avatar.started ack:", err);
  }
}

void main();

// Export nothing — this file is loaded as a plain module script.
export {};
