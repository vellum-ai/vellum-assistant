/**
 * HTTP control surface for the meet-bot container.
 *
 * Exposes a small Hono app that the assistant daemon talks to:
 *
 *   - `GET  /health`                  — liveness/health probe (also used by Docker HEALTHCHECK).
 *   - `GET  /status`                  — full lifecycle snapshot.
 *   - `POST /leave`                   — ask the bot to leave the meeting.
 *   - `POST /send_chat`               — post a chat message into the Meet chat panel.
 *   - `POST /play_audio`              — stream raw PCM into pacat (Phase 3).
 *   - `DELETE /play_audio/:streamId`  — cancel an in-flight playback (barge-in).
 *
 * Every mutating route validates its body against the corresponding Zod
 * schema from `@vellumai/meet-contracts` so command shapes stay in sync with
 * the daemon side of the wire protocol.
 *
 * Auth: every route (including `/health`, so the probe matches production)
 * requires a `Authorization: Bearer <token>` header matching the `apiToken`
 * injected at construction time. The token is provisioned per meeting by the
 * daemon and passed to the container via environment variable.
 */

import {
  LeaveCommandSchema,
  SendChatCommandSchema,
} from "@vellumai/meet-contracts";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import {
  startAudioPlayback,
  type AudioPlaybackHandle,
  type StartAudioPlaybackOptions,
} from "../media/audio-playback.js";
import { BotState } from "./state.js";

/**
 * Google Meet enforces a 2000-character ceiling on a single chat message.
 * We mirror that limit at the HTTP boundary so oversized payloads are
 * rejected with a clear 400 instead of silently being truncated (or worse,
 * causing Meet to reject the keystrokes and leave the bot in a half-typed
 * state).
 */
const MEET_CHAT_MAX_LENGTH = 2000;

/**
 * Callbacks the HTTP server invokes when commands arrive.
 *
 * The server is a thin wiring layer: it validates the incoming payload,
 * updates the lifecycle phase where appropriate, and delegates the actual
 * work (driving Playwright, talking to the ASR pipeline, etc.) to these
 * callbacks. Phases 2 and 3 replace the 501 stubs with real implementations.
 */
export interface HttpServerCallbacks {
  /** Called when `POST /leave` is received and the phase has been flipped. */
  onLeave: (reason: string | undefined) => Promise<void> | void;
  /**
   * Called when `POST /send_chat` is received with a valid body. The
   * implementation is expected to type `text` into the Meet chat composer
   * and submit it. Throwing (or rejecting) is the signal that Playwright
   * could not post the message — the HTTP route converts that into a 502.
   */
  onSendChat: (text: string) => Promise<void> | void;
  /**
   * Called when a `POST /play_audio` stream starts. The real PCM payload
   * is consumed by the route directly and streamed into pacat; this
   * callback exists for lifecycle observation (logging, metrics, joining
   * the stream to an in-memory barge-in registry).
   */
  onPlayAudio: (streamId: string) => Promise<void> | void;
}

export interface CreateHttpServerOptions extends HttpServerCallbacks {
  /** Bearer token required on every request. */
  apiToken: string;
  /**
   * Override for the audio-playback factory. In production we call
   * `startAudioPlayback` from `../media/audio-playback.js`; tests inject a
   * handle whose `write` captures bytes into a buffer.
   */
  startPlayback?: (opts?: StartAudioPlaybackOptions) => AudioPlaybackHandle;
  /**
   * Override for pacat spawn. Forwarded into the default `startPlayback`
   * when tests want the singleton behavior but still need to stub out the
   * child process.
   */
  playbackSpawnOptions?: StartAudioPlaybackOptions;
}

export interface HttpServerHandle {
  /** The underlying Hono app — exposed for tests that want to call `fetch`. */
  readonly app: Hono;
  /** Start listening on the given port. Pass `0` to pick a random free port. */
  start: (port: number) => Promise<{ port: number }>;
  /** Stop the listener (no-op if never started). */
  stop: () => Promise<void>;
}

/**
 * Trailing silence pushed at the end of a clean stream (or when a stream
 * is cancelled) so the null-sink doesn't leave the last PCM sample held in
 * Chrome's resampler, which surfaces as a "pop" to other participants.
 */
const TRAILING_SILENCE_MS = 50;

/**
 * In-flight playback registry — keyed by the stream's uuid so `DELETE
 * /play_audio/:streamId` can target a specific stream. The value is just
 * the `AbortController` the POST handler is racing against.
 */
interface ActiveStream {
  controller: AbortController;
  handle: AudioPlaybackHandle;
}

/** Build (but do not start) the HTTP server. */
export function createHttpServer(
  options: CreateHttpServerOptions,
): HttpServerHandle {
  const {
    apiToken,
    onLeave,
    onSendChat,
    onPlayAudio,
    startPlayback,
    playbackSpawnOptions,
  } = options;
  const playbackFactory = startPlayback ?? startAudioPlayback;

  const activeStreams = new Map<string, ActiveStream>();

  const app = new Hono();

  // -------------------------------------------------------------------------
  // Auth middleware — applied to every route.
  // -------------------------------------------------------------------------

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json({ error: "missing or malformed authorization header" }, 401);
    }
    const token = header.slice("Bearer ".length).trim();
    if (token !== apiToken) {
      return c.json({ error: "invalid token" }, 401);
    }
    await next();
  });

  // -------------------------------------------------------------------------
  // GET /health — 200 unless the bot is in the error phase.
  // -------------------------------------------------------------------------

  app.get("/health", (c) => {
    const { phase } = BotState.snapshot();
    if (phase === "error") {
      return c.json({ ok: false, phase }, 503);
    }
    return c.json({ ok: true, phase }, 200);
  });

  // -------------------------------------------------------------------------
  // GET /status — expose the full lifecycle snapshot.
  // -------------------------------------------------------------------------

  app.get("/status", (c) => {
    return c.json(BotState.snapshot(), 200);
  });

  // -------------------------------------------------------------------------
  // POST /leave — transition to "leaving" and delegate.
  // -------------------------------------------------------------------------

  app.post("/leave", async (c) => {
    const body = await readJson(c);
    const parsed = LeaveCommandSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    BotState.setPhase("leaving");
    // Kick off the leave in the background — we want to ACK fast.
    void Promise.resolve(onLeave(parsed.data.reason)).catch(() => {
      // Swallowing here on purpose; the real main.ts will wire lifecycle
      // error reporting to this callback.
    });
    return c.json({ accepted: true }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /send_chat — validate, enforce Meet's 2000-char chat limit, then
  // hand off to the Playwright-backed callback. Success returns 200; a
  // thrown/rejected callback is surfaced as 502 so the daemon can tell
  // "bad request" apart from "Meet DOM didn't cooperate".
  // -------------------------------------------------------------------------

  app.post("/send_chat", async (c) => {
    const body = await readJson(c);
    const parsed = SendChatCommandSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    if (parsed.data.text.length > MEET_CHAT_MAX_LENGTH) {
      return c.json(
        {
          error: `text exceeds Meet chat limit of ${MEET_CHAT_MAX_LENGTH} characters`,
          length: parsed.data.text.length,
        },
        400,
      );
    }
    try {
      await onSendChat(parsed.data.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ sent: false, error: message }, 502);
    }
    return c.json({ sent: true, timestamp: new Date().toISOString() }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /play_audio — stream raw PCM body into pacat.
  //
  // The body is `application/octet-stream`: s16le mono 48kHz PCM, framed
  // however the daemon likes (chunks don't need to be sample-aligned; pacat
  // buffers internally). We allocate a stream id per request (either from
  // `?stream_id=` or a fresh uuid) so a later `DELETE /play_audio/:id` can
  // cancel this specific pipeline for barge-in.
  //
  // Status codes:
  //   - 200 `{ streamId, bytes }` — body fully forwarded.
  //   - 400                       — wrong content-type.
  //   - 499                       — cancelled mid-stream (client-closed OR
  //                                 `DELETE /play_audio/:id` fired).
  //   - 500 `{ error }`           — pacat failed to start / write errored.
  // -------------------------------------------------------------------------

  app.post("/play_audio", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
      return c.json(
        {
          error:
            "invalid content-type; expected application/octet-stream (raw PCM)",
        },
        400,
      );
    }

    const providedId = c.req.query("stream_id");
    const streamId =
      providedId && providedId.length > 0 ? providedId : randomUUID();

    // If a stream id was reused, cancel whatever's in flight first. This
    // matches the barge-in semantics we want in Phase 3: a fresh POST with
    // the same id supersedes the old one.
    const existing = activeStreams.get(streamId);
    if (existing) {
      existing.controller.abort();
    }

    let handle: AudioPlaybackHandle;
    try {
      handle = playbackFactory(playbackSpawnOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `failed to start playback: ${message}` }, 500);
    }

    const controller = new AbortController();
    activeStreams.set(streamId, { controller, handle });

    // Observability hook — invoked fire-and-forget so slow callbacks don't
    // stall the audio pipeline.
    void Promise.resolve(onPlayAudio(streamId)).catch(() => {});

    const body = c.req.raw.body;
    if (!body) {
      activeStreams.delete(streamId);
      // No body is treated as an empty stream — flush trailing silence for
      // symmetry and return success.
      try {
        await handle.flushSilence(TRAILING_SILENCE_MS);
      } catch {
        // Best-effort; silence is cosmetic.
      }
      return c.json({ streamId, bytes: 0 }, 200);
    }

    let bytes = 0;
    let cancelled = false;
    let writeError: Error | null = null;

    const reader = body.getReader();
    const abortPromise = new Promise<void>((resolve) => {
      if (controller.signal.aborted) {
        cancelled = true;
        resolve();
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          try {
            // Best-effort — releases the reader so the `read()` loop sees
            // EOF on the next iteration.
            reader.cancel().catch(() => {});
          } catch {
            // ignore
          }
          resolve();
        },
        { once: true },
      );
    });

    try {
      while (true) {
        const readP = reader.read();
        const next = await Promise.race([
          readP.then((r) => ({ kind: "read" as const, value: r })),
          abortPromise.then(() => ({ kind: "abort" as const })),
        ]);

        if (next.kind === "abort") {
          break;
        }
        const { value, done } = next.value;
        if (done) break;
        if (!value || value.length === 0) continue;

        try {
          await handle.write(value);
          bytes += value.length;
        } catch (err) {
          writeError = err instanceof Error ? err : new Error(String(err));
          break;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Lock may already be released after `cancel()`; fine.
      }
      activeStreams.delete(streamId);
      // Always flush trailing silence so we don't "pop" — even on cancel,
      // which intentionally stops PCM mid-frame.
      try {
        await handle.flushSilence(TRAILING_SILENCE_MS);
      } catch {
        // Best-effort.
      }
    }

    if (writeError) {
      return c.json(
        { error: `playback write failed: ${writeError.message}`, bytes },
        500,
      );
    }
    if (cancelled) {
      // 499 — Nginx's convention for "client closed request"; used here as
      // the signal that playback was interrupted (either by the HTTP peer
      // dropping or by DELETE /play_audio/:id). Hono's typed status codes
      // don't include 499 (it's non-standard), so we build the Response by
      // hand.
      return new Response(
        JSON.stringify({ streamId, bytes, cancelled: true }),
        {
          status: 499,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return c.json({ streamId, bytes }, 200);
  });

  // -------------------------------------------------------------------------
  // DELETE /play_audio/:streamId — cancel a specific in-flight playback.
  //
  // Used by barge-in (PR 3): when the daemon detects the user talking over
  // the bot, it nukes the active stream so pacat stops writing into
  // `bot_out`. Returns 404 if no such stream exists (which is a normal
  // race — the stream might have just completed).
  // -------------------------------------------------------------------------

  app.delete("/play_audio/:streamId", async (c) => {
    const streamId = c.req.param("streamId");
    const stream = activeStreams.get(streamId);
    if (!stream) {
      return c.json({ error: "no such stream", streamId }, 404);
    }
    stream.controller.abort();
    // Don't wait for the POST handler to finish — the DELETE is an
    // interrupt, not a join point. The POST side is responsible for
    // flushing silence and clearing its registry entry.
    return c.json({ cancelled: true, streamId }, 200);
  });

  // -------------------------------------------------------------------------
  // Lifecycle — Bun's native server as the listener.
  // -------------------------------------------------------------------------

  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    app,
    async start(port) {
      if (server !== null) {
        throw new Error("http-server already started");
      }
      server = Bun.serve({
        hostname: "0.0.0.0",
        port,
        fetch: app.fetch,
      });
      const boundPort = server.port;
      if (boundPort === undefined) {
        throw new Error("http-server failed to bind to a port");
      }
      return { port: boundPort };
    },
    async stop() {
      if (server === null) return;
      await server.stop(true);
      server = null;
    },
  };
}

/**
 * Read a JSON body, returning `undefined` when the body is missing or
 * malformed so downstream schema validation produces a 400 rather than a
 * 500.
 */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
