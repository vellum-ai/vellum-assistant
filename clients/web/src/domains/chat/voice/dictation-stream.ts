/**
 * Streaming dictation partials over the daemon's `/v1/stt/stream` WebSocket.
 *
 * Web Speech API partials are dead inside the Electron shell (Chromium ships
 * the binding without the speech service behind it), so dictation there has
 * no live transcript on its own. This module streams mic audio to the
 * daemon's STT stream session and renders its `partial` events.
 *
 * The session runs alongside the `MediaRecorder` → batch `/v1/stt/transcribe`
 * flow in `voice-input-button.tsx` and serves two things. Its partials are the
 * live transcript. Its finals, flushed by the provider when the session is
 * stopped, are a complete transcript of the recording that exists the moment
 * the user stops speaking, since the audio was already there: the button
 * prefers that over uploading the recording again for a dictation that was
 * started from the keyboard, where the wait is the whole experience. If the
 * stream can't start (no ingress, provider without streaming support, capture
 * failure), dictation proceeds on the batch path alone.
 *
 * Transport follows `live-voice/connection.ts` and the watch stream. A
 * self-hosted assistant is dialled straight at its gateway ingress with the
 * actor edge JWT in `?token=` (browser WebSockets can't set an `Authorization`
 * header); a managed one is reached through the platform's velay ingress with
 * a minted short-lived token. The mint is a round trip, so the socket is
 * resolved asynchronously and audio captured meanwhile is held until it opens,
 * which is what keeps the opening words of a dictation that begins the
 * instant a key goes down.
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
import {
  buildSelfHostedGatewayWsUrl,
  buildVelayWsUrl,
  isPairedGatewayIngress,
  mintVelayWsToken,
  PairedVoiceUnavailableError,
  VelayWsTokenError,
} from "@/domains/chat/voice/live-voice/connection";
import { LIVE_VOICE_AUDIO_FORMAT_PARAMS } from "@/domains/chat/voice/live-voice/protocol";
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
   * Stop capture, ask the provider to flush, and close the session once it
   * has. Resolves with the committed transcript, which is complete: every
   * final the provider had left to say arrives before it closes. `null` when
   * the session never went live, so a caller can tell "nothing was said" from
   * "nothing was heard". Idempotent, and never rejects.
   */
  stop(): Promise<string | null>;
}

export interface StartDictationStreamArgs {
  /** Whose assistant the session is for, which is what a velay token is minted against. */
  assistantId: string;
  /**
   * Receives the running transcript (committed finals + current interim)
   * on every partial/final event.
   */
  onPartial: (text: string) => void;
}

/**
 * How long a stop waits for the provider to flush and close before the
 * transcript is taken as it stands. A provider that has gone quiet is not
 * worth more than this: the recording is still uploaded on the batch path.
 */
const STOP_FLUSH_TIMEOUT_MS = 4000;

/**
 * Where the session's socket is, for a given assistant.
 *
 * The same shape as the watch stream's resolver and live voice's, since all
 * three are gateway WebSocket routes with the same two ways in. Throws the
 * same errors they do for the same reasons; see `resolveWatchStreamWsUrl`.
 */
export async function resolveDictationStreamWsUrl(
  assistantId: string,
): Promise<string> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (ingressUrl) {
    if (isPairedGatewayIngress(ingressUrl)) {
      throw new PairedVoiceUnavailableError();
    }
    const token = getSelfHostedActorToken();
    if (!token) {
      throw new VelayWsTokenError(
        0,
        "Self-hosted dictation has no actor token yet; the gateway isn't ready.",
      );
    }
    return buildSttStreamWsUrl({ ingressUrl, token });
  }

  const { token } = await mintVelayWsToken(assistantId);
  return buildVelayWsUrl({
    assistantId,
    routePath: STT_STREAM_ROUTE,
    token,
    params: LIVE_VOICE_AUDIO_FORMAT_PARAMS,
  });
}

const STT_STREAM_ROUTE = "/v1/stt/stream";

/** Injection seams for tests. */
export interface DictationStreamOptions {
  webSocketFactory?: (url: string) => WebSocket;
  /** Where the socket is, resolved asynchronously. See {@link resolveDictationStreamWsUrl}. */
  resolveWsUrl?: (assistantId: string) => Promise<string>;
  captureFactory?: (options: LiveVoiceAudioCaptureOptions) => {
    start(): Promise<LiveVoiceCaptureResult>;
    shutdown(): void;
    flush?(): void;
  };
}

/**
 * Build the self-hosted STT stream WebSocket URL:
 *
 *   ws(s)://<ingressHost>/v1/stt/stream?token=…&mimeType=audio/pcm&sampleRate=16000
 *
 * Delegates to {@link buildSelfHostedGatewayWsUrl} so this dictation stream and
 * live-voice share one transport rule set — including the local
 * `/assistant/__gateway/<port>` → loopback bypass (the HTTP-only proxy can't
 * carry a WS upgrade). Exported for unit tests.
 */
export function buildSttStreamWsUrl({
  ingressUrl,
  token,
}: {
  ingressUrl: string;
  token: string;
}): string {
  return buildSelfHostedGatewayWsUrl({
    ingressUrl,
    routePath: STT_STREAM_ROUTE,
    token,
    params: LIVE_VOICE_AUDIO_FORMAT_PARAMS,
  });
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
  { assistantId, onPartial }: StartDictationStreamArgs,
  options: DictationStreamOptions = {},
): DictationStreamHandle | null {
  if (!isPcmCaptureSupported()) {
    // Plain browsers without an AudioWorklet. Logged once per attempt so a
    // missing-partials report is diagnosable.
    console.info("dictation-stream: skipping (no AudioWorklet)");
    return null;
  }

  const webSocketFactory =
    options.webSocketFactory ?? ((url: string) => new WebSocket(url));

  let ws: WebSocket | null = null;
  let live = false;
  let closed = false;
  let committedText = "";
  // Audio captured before the socket is open. The token mint is a round trip
  // and a dictation started from a key begins the instant it goes down, so
  // dropping what arrives meanwhile would drop the opening words.
  let held: ArrayBuffer[] = [];
  // When the caller asked for the flush, so the close can say how long it took.
  let stopRequestedAt: number | null = null;
  // Whether the runtime ended the session itself, which after a stop is it
  // saying the flush is done. Any other way out is a failure, whatever text
  // had been committed by then.
  let closedByServer = false;
  // A stop asked for before the runtime was ready to hear it.
  let stopPending = false;

  const sendStop = (socket: WebSocket): void => {
    try {
      socket.send(JSON.stringify({ type: "stop" }));
    } catch {
      // Socket raced shut. The flush timeout finishes the session.
    }
  };
  // Settled by `teardown`, which every way out of the session runs through.
  let settleStop: ((text: string | null) => void) | null = null;
  const stopped = new Promise<string | null>((resolve) => {
    settleStop = resolve;
  });

  const capture = (
    options.captureFactory ??
    ((captureOptions: LiveVoiceAudioCaptureOptions) =>
      new LiveVoiceAudioCapture(captureOptions))
  )({
    onChunk: (buf) => {
      // Nothing after the stop is part of the dictation. The mic is on its
      // way down by then, and a quantum that beats the disconnect would
      // otherwise go out ahead of a stop still waiting on `ready`.
      if (closed || stopRequestedAt !== null) {
        return;
      }
      // Until `ready`, not until the socket opens. The runtime discards audio
      // that arrives before its transcriber is up, and that is the same
      // moment it sends `ready`, so a frame sent on `open` lands in the gap
      // and is the opening words gone for a second reason.
      if (live && ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(buf);
        return;
      }
      held.push(buf);
    },
  });

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    // Only a session that was asked to stop and then closed of its own accord
    // has finished its transcript. One that errored or dropped mid-way has a
    // prefix of one, and a prefix handed over as the whole would be inserted
    // as the whole: the caller cannot tell the two apart, so this has to.
    const finished = live && stopRequestedAt !== null && closedByServer;
    live = false;
    held = [];
    capture.shutdown();
    if (
      ws !== null &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      try {
        ws.close(1000);
      } catch {
        // Already closing — nothing to clean up.
      }
    }
    settleStop?.(finished ? committedText : null);
  };

  const attach = (socket: WebSocket): void => {
    ws = socket;

    socket.addEventListener("open", () => {
      console.info(`dictation-stream: open after ${Date.now() - startedAt}ms`);
    });

    socket.addEventListener("message", (event) => {
      if (closed || typeof event.data !== "string") {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const message = parsed as { type?: string; text?: string };
      switch (message.type) {
        case "ready":
          live = true;
          console.info(
            `dictation-stream: ready after ${Date.now() - startedAt}ms, releasing ${held.length} held chunks`,
          );
          for (const buf of held) {
            socket.send(buf);
          }
          held = [];
          if (stopPending) {
            stopPending = false;
            sendStop(socket);
          }
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
        // error, and the session degrades to batch-only.
        case "error":
          console.warn(
            "dictation-stream: server error event",
            (parsed as { message?: string; category?: string }).category ?? "",
            (parsed as { message?: string }).message ?? event.data,
          );
          teardown();
          return;
        case "closed":
          console.info(
            `dictation-stream: closed by server ${stopRequestedAt === null ? "unprompted" : `${Date.now() - stopRequestedAt}ms after stop`}, committedChars=${committedText.length}`,
          );
          closedByServer = true;
          teardown();
          return;
        default:
          return;
      }
    });

    socket.addEventListener("close", (event) => {
      // A close before `ready` means the session never delivered a partial;
      // surface why (CSP-blocked sockets land here with code 1006, and a
      // gateway that could not reach the assistant with 1014).
      if (!live && !closed) {
        console.warn(
          `dictation-stream: socket closed before ready (code ${event.code}${event.reason ? `, ${event.reason}` : ""}) after ${Date.now() - startedAt}ms`,
        );
      }
      teardown();
    });
    socket.addEventListener("error", teardown);
  };

  // Capture starts now rather than on the socket opening, since the socket
  // may be a token mint away and the speaker is not waiting for it.
  void capture.start().then((result) => {
    // Mic denied / device busy: no partials, batch capture unaffected.
    if (!result.ok) {
      console.warn("dictation-stream: PCM capture failed", result.error);
      teardown();
    }
  });

  const startedAt = Date.now();
  const resolveWsUrl = options.resolveWsUrl ?? resolveDictationStreamWsUrl;
  void resolveWsUrl(assistantId).then(
    (url) => {
      if (closed) {
        return;
      }
      // Which way in, and how long the token took, without the token.
      console.info(
        `dictation-stream: dialling ${new URL(url).host} (${getSelfHostedIngressUrl() ? "self-hosted" : "velay"}) after ${Date.now() - startedAt}ms`,
      );
      try {
        attach(webSocketFactory(url));
      } catch (err) {
        console.warn("dictation-stream: could not open socket", err);
        teardown();
      }
    },
    (err: unknown) => {
      // A paired ingress, a token not yet provisioned, or a mint the platform
      // refused. Each is a reason there is no stream, not a fault: batch
      // dictation still works, and only the live half is missing.
      console.info(
        "dictation-stream: skipping",
        err instanceof Error ? err.message : String(err),
      );
      teardown();
    },
  );

  return {
    isLive: () => live && !closed,
    stop: () => {
      // Asked already, or nothing left to ask: the same promise either way,
      // so a second caller waits on the same flush rather than sending a
      // second stop.
      if (closed || stopRequestedAt !== null) {
        return stopped;
      }
      // The last <50ms may still sit in the capture's batch accumulator;
      // drain it (synchronously, via onChunk) before asking the provider
      // to flush finals.
      capture.flush?.();
      stopRequestedAt = Date.now();
      // The key is up, so the mic goes now. The session stays up for the
      // runtime to finish what it was already sent.
      capture.shutdown();
      // A hold short enough to end before `ready` has its audio still held,
      // and possibly no socket yet: the token mint is a round trip and the
      // socket a handshake behind it. The runtime ignores a stop it is not
      // ready for, so the stop waits for `ready` and goes out from that
      // handler, right behind the audio it is asking the runtime to finish.
      // A session that never gets there closes some other way, and each of
      // those settles the stop through `teardown`.
      if (live && ws !== null && ws.readyState === WebSocket.OPEN) {
        sendStop(ws);
      } else {
        stopPending = true;
      }
      // The provider flushes what it has left and the session closes
      // behind it, which is what settles `stopped` through `teardown`.
      // A provider that has gone quiet, or a dial that never completes, is
      // given this long and no more.
      setTimeout(teardown, STOP_FLUSH_TIMEOUT_MS);
      return stopped;
    },
  };
}
