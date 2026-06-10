/**
 * Streaming dictation partials over the daemon's `/v1/stt/stream` WebSocket.
 *
 * Web Speech API partials are dead inside the Electron shell (Chromium ships
 * the binding without the speech service behind it), so dictation there had
 * no live transcript at all — the legacy Swift client solved this by
 * streaming mic audio to the daemon's STT stream session and rendering its
 * `partial` events. This module is that client for the web renderer.
 *
 * Scope: **interim display only.** The session runs alongside the existing
 * `MediaRecorder` → batch `/v1/stt/transcribe` flow in
 * `voice-input-button.tsx`, which remains the sole authority for the final
 * inserted text. If the stream can't start (no self-hosted gateway ingress,
 * provider without streaming support, capture failure), dictation simply
 * proceeds without live partials — exactly today's behavior.
 *
 * Transport mirrors `live-voice/connection.ts`'s self-hosted path: connect
 * straight to the user's gateway ingress with the actor edge JWT in
 * `?token=` (browser WebSockets can't set an `Authorization` header). The
 * cloud/velay path is deliberately not wired — the Electron shell (this
 * feature's target) always talks to a local/self-hosted gateway, matching
 * the legacy native client.
 *
 * Audio is the live-voice capture pipeline's 16 kHz mono PCM16LE
 * (`LiveVoiceAudioCapture`), sent as binary frames; the runtime session
 * (`assistant/src/stt/stt-stream-session.ts`) emits sequenced JSON events:
 * `ready`, `partial`, `final`, `error`, `closed`. A `{type:"stop"}` text
 * frame asks the provider to flush.
 */

import {
  LiveVoiceAudioCapture,
  isSupported as isPcmCaptureSupported,
  type LiveVoiceAudioCaptureOptions,
  type LiveVoiceCaptureResult,
} from "@/domains/chat/voice/live-voice/pcm-capture";
import { LIVE_VOICE_AUDIO_FORMAT } from "@/domains/chat/voice/live-voice/protocol";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";

export interface DictationStreamHandle {
  /**
   * True once the runtime accepted the session (`ready` received) and until
   * teardown. Used by `voice-input-button.tsx` to give streaming partials
   * priority over Web Speech partials (mirrors the legacy client's rule).
   */
  isLive(): boolean;
  /**
   * Stop capture, ask the provider to flush, and close the session.
   * Idempotent.
   */
  stop(): void;
}

export interface StartDictationStreamArgs {
  /**
   * Receives the running transcript (committed finals + current interim)
   * on every partial/final event.
   */
  onPartial: (text: string) => void;
}

/** Injection seams for tests. */
export interface DictationStreamOptions {
  webSocketFactory?: (url: string) => WebSocket;
  captureFactory?: (options: LiveVoiceAudioCaptureOptions) => {
    start(): Promise<LiveVoiceCaptureResult>;
    shutdown(): void;
  };
}

/**
 * Build the self-hosted STT stream WebSocket URL:
 *
 *   ws(s)://<ingressHost>/v1/stt/stream?token=…&mimeType=audio/pcm&sampleRate=16000
 *
 * Same shape rules as `buildSelfHostedLiveVoiceWsUrl`: scheme follows the
 * ingress (`http`→`ws`, `https`→`wss`), any ingress path prefix is preserved
 * (local Docker mode proxies the gateway at a sub-path), and query/hash on
 * the ingress are dropped. Exported for unit tests.
 */
export function buildSttStreamWsUrl({
  ingressUrl,
  token,
}: {
  ingressUrl: string;
  token: string;
}): string {
  const url = new URL(ingressUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/v1/stt/stream`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("token", token);
  url.searchParams.set("mimeType", LIVE_VOICE_AUDIO_FORMAT.mimeType);
  url.searchParams.set("sampleRate", String(LIVE_VOICE_AUDIO_FORMAT.sampleRate));
  return url.toString();
}

/** Join transcript segments with a single space, ignoring blanks. */
function joinTranscript(a: string, b: string): string {
  return [a.trim(), b.trim()].filter(Boolean).join(" ");
}

/**
 * Open a streaming dictation session for live partials.
 *
 * Returns `null` when streaming isn't possible in this environment (no
 * self-hosted ingress/actor token, or no AudioWorklet support) so callers
 * can skip it without branching on platform. All later failures — provider
 * without streaming support, capture denial, socket errors — tear the
 * session down silently; the batch recording path is unaffected.
 */
export function startDictationStream(
  { onPartial }: StartDictationStreamArgs,
  options: DictationStreamOptions = {},
): DictationStreamHandle | null {
  const ingressUrl = getSelfHostedIngressUrl();
  const token = getSelfHostedActorToken();
  if (!ingressUrl || !token || !isPcmCaptureSupported()) {
    // Expected on cloud-hosted assistants and plain browsers — log once
    // per session attempt so a missing-partials report is diagnosable.
    console.info(
      "dictation-stream: skipping (no self-hosted ingress/token or no AudioWorklet)",
    );
    return null;
  }

  const webSocketFactory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));

  let ws: WebSocket;
  try {
    ws = webSocketFactory(buildSttStreamWsUrl({ ingressUrl, token }));
  } catch {
    return null;
  }

  let live = false;
  let closed = false;
  let committedText = "";

  const capture = (
    options.captureFactory ??
    ((captureOptions: LiveVoiceAudioCaptureOptions) =>
      new LiveVoiceAudioCapture(captureOptions))
  )({
    onChunk: (buf) => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
      }
    },
  });

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    live = false;
    capture.shutdown();
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      try {
        ws.close(1000);
      } catch {
        // Already closing — nothing to clean up.
      }
    }
  };

  ws.addEventListener("open", () => {
    if (closed) return;
    void capture.start().then((result) => {
      // Mic denied / device busy: no partials, batch capture unaffected.
      if (!result.ok) {
        console.warn("dictation-stream: PCM capture failed", result.error);
        teardown();
      }
    });
  });

  ws.addEventListener("message", (event) => {
    if (closed || typeof event.data !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    const message = parsed as { type?: string; text?: string };
    switch (message.type) {
      case "ready":
        live = true;
        return;
      case "partial":
        if (typeof message.text === "string") {
          onPartial(joinTranscript(committedText, message.text));
        }
        return;
      case "final":
        if (typeof message.text === "string") {
          committedText = joinTranscript(committedText, message.text);
          onPartial(committedText);
        }
        return;
      // Includes the structured "streaming not supported for provider"
      // error — the session degrades to batch-only.
      case "error":
        console.warn(
          "dictation-stream: server error event",
          (parsed as { message?: string }).message ?? event.data,
        );
        teardown();
        return;
      case "closed":
        teardown();
        return;
      default:
        return;
    }
  });

  ws.addEventListener("close", (event) => {
    // A close before `ready` means the session never delivered a partial —
    // surface why (CSP-blocked sockets land here with code 1006).
    if (!live && !closed) {
      console.warn(
        `dictation-stream: socket closed before ready (code ${event.code})`,
      );
    }
    teardown();
  });
  ws.addEventListener("error", teardown);

  return {
    isLive: () => live && !closed,
    stop: () => {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "stop" }));
        } catch {
          // Socket raced shut — teardown below handles it.
        }
      }
      teardown();
    },
  };
}
