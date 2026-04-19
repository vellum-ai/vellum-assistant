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
 *   - `POST /avatar/enable`           — start the configured avatar renderer, wire its frames to `/dev/video10`, then flip the Meet camera toggle ON via the camera channel.
 *   - `POST /avatar/disable`          — flip the Meet camera toggle OFF (before renderer teardown to avoid a brief black frame), then tear down the renderer + detach the device writer.
 *   - `POST /avatar/viseme`           — forward a viseme event into the active renderer (no-op when disabled).
 *
 * Every mutating route validates its body against the corresponding Zod
 * schema from the contracts barrel so command shapes stay in sync with
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
} from "../../../contracts/index.js";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";

import {
  attachDeviceWriter,
  AvatarRendererUnavailableError,
  resolveAvatarRenderer,
  type AvatarConfig,
  type AvatarNativeMessagingSender,
  type AvatarRenderer,
  type DeviceWriterHandle,
  type VisemeEvent,
} from "../media/avatar/index.js";
import type { VideoDeviceHandle } from "../media/video-device.js";
import { openVideoDevice as defaultOpenVideoDevice } from "../media/video-device.js";
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
 * work (dispatching to the Chrome extension over native messaging, talking
 * to the ASR pipeline, etc.) to these callbacks. Phases 2 and 3 replace the
 * 501 stubs with real implementations.
 */
export interface HttpServerCallbacks {
  /** Called when `POST /leave` is received and the phase has been flipped. */
  onLeave: (reason: string | undefined) => Promise<void> | void;
  /**
   * Called when `POST /send_chat` is received with a valid body. The
   * implementation is expected to forward `text` to the Chrome extension
   * (via the NMH socket) so the extension can type it into the Meet chat
   * composer and submit it. Throwing (or rejecting) is the signal that the
   * extension could not post the message — the HTTP route converts that
   * into a 502.
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
  /**
   * Avatar-subsystem options. When absent, the `/avatar/*` routes still
   * mount (the surface is always present for a consistent API) but every
   * route returns 503 with an "avatar disabled" body, so callers that
   * POST to `/avatar/enable` get a clear error rather than silent
   * success. Populated by `main.ts` at boot when the avatar feature is
   * opted into via `AVATAR_ENABLED=1`.
   */
  avatar?: HttpServerAvatarOptions;
}

/**
 * Configuration handed to `createHttpServer` when the avatar subsystem
 * is available. Mirrors the dependency-injection pattern the rest of
 * the bot uses so tests can stub out the registry, the device opener,
 * and the config without touching real v4l2 devices.
 */
export interface HttpServerAvatarOptions {
  /**
   * Fully-resolved `services.meet.avatar.*` config block the daemon
   * passed down via env vars. Contains at least `renderer` + `enabled`;
   * renderer-specific sub-objects are accessed by name inside each
   * factory. Credentials are already resolved to raw values (the bot
   * has no vault access) so any credential field in this object is
   * safe to read directly.
   */
  config: AvatarConfig;
  /**
   * Renderer-resolver override. Defaults to
   * {@link resolveAvatarRenderer}; tests swap in a lambda that returns
   * a `FakeAvatarRenderer` so the HTTP flow can be exercised without
   * registering a real backend.
   */
  resolveRenderer?: (
    config: AvatarConfig,
  ) => AvatarRenderer | null;
  /**
   * Native-messaging surface forwarded to the renderer factory's
   * `deps.nativeMessaging`. Renderers that drive an extension-hosted
   * avatar (TalkingHead.js) require this; renderers that render
   * server-side or delegate to a hosted WebRTC backend ignore it.
   * When absent, `/avatar/enable` falls back to a deps bag without a
   * native-messaging surface — the TalkingHead factory then throws
   * {@link AvatarRendererUnavailableError} and the route returns 503.
   */
  nativeMessaging?: AvatarNativeMessagingSender;
  /**
   * Device opener override. Defaults to
   * {@link defaultOpenVideoDevice}; tests provide a shim that returns
   * an in-memory sink so `/avatar/enable` can run without a real
   * `/dev/video10` on the test host. When absent, the default is used.
   */
  openDevice?: (devicePath: string) => Promise<VideoDeviceHandle>;
  /**
   * Explicit device path override. When absent, the runtime falls
   * back to whatever default the device opener uses (today
   * `/dev/video10`).
   */
  devicePath?: string;
  /**
   * Maximum FPS cap applied to renderer output before it reaches the
   * device sink. Defaults to the module default; kept configurable so
   * tests can validate FPS-gating behavior.
   */
  maxFps?: number;
  /**
   * Camera-channel handle the server uses to ask the extension to turn
   * the Meet camera on / off. When absent, `/avatar/enable` starts the
   * renderer and `/avatar/disable` stops it — without flipping the
   * camera toggle. This is the boot-smoke-test behavior (no extension
   * is attached) and also the fallback when the extension is temporarily
   * disconnected.
   *
   * When present, `/avatar/enable` starts the renderer FIRST (so the
   * v4l2loopback device has frames to emit the moment Meet reads from
   * it) and then flips the camera toggle ON; `/avatar/disable` flips the
   * toggle OFF FIRST (so Meet stops emitting to other participants
   * before the renderer tears down the frames) and then stops the
   * renderer. This ordering avoids a brief black frame between the two
   * transitions that other participants would otherwise see.
   *
   * A failed camera toggle is non-fatal on the enable path: the server
   * logs the failure via the response body and leaves the renderer
   * running, since tearing it back down would be strictly worse than a
   * stuck camera toggle. On the disable path, a failed toggle is also
   * non-fatal — we still stop the renderer so the device doesn't leak
   * frames into a Meet tab that may still have the camera on.
   */
  camera?: {
    enableCamera: () => Promise<{ changed: boolean }>;
    disableCamera: () => Promise<{ changed: boolean }>;
  };
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
 * /play_audio/:streamId` can target a specific stream. Cross-stream
 * serialization (so concurrent POSTs with different ids can't interleave
 * PCM on the shared pacat stdin) is handled separately via a chained
 * playback promise; this registry just exists so individual cancels can
 * be routed to the right abort controller.
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
    avatar,
  } = options;
  const playbackFactory = startPlayback ?? startAudioPlayback;

  // Avatar state — nulls when the subsystem isn't active. Guarded by a
  // serialization lock (`avatarMutationChain`) so concurrent `/avatar/enable`
  // + `/avatar/disable` requests can't interleave a half-torn-down renderer
  // with a fresh one.
  let avatarRenderer: AvatarRenderer | null = null;
  let avatarDeviceHandle: VideoDeviceHandle | null = null;
  let avatarDeviceWriter: DeviceWriterHandle | null = null;
  let avatarMutationChain: Promise<unknown> = Promise.resolve();

  const activeStreams = new Map<string, ActiveStream>();

  /**
   * Tail of the playback queue. Every POST /play_audio appends itself to
   * this chain so handlers run strictly one at a time — critical because
   * audio-playback's module-level singleton hands every handler the same
   * pacat stdin, and two concurrent `handle.write(...)` loops would
   * interleave PCM bytes on that shared sink. When a new POST arrives it
   * (a) aborts everything currently registered and (b) awaits the current
   * `playbackChain` before doing any writes of its own, then publishes a
   * fresh promise as the new tail for the next arrival to queue behind.
   */
  let playbackChain: Promise<void> = Promise.resolve();

  /**
   * Tail of the chat-send queue. Concurrent POST /send_chat requests must
   * not interleave extension commands on the shared chat input — one
   * fill/press sequence (run inside the extension) must complete before
   * the next begins, otherwise two messages race on the same DOM element
   * and both may be lost or garbled. Identical pattern to `playbackChain`
   * above.
   */
  let chatChain: Promise<void> = Promise.resolve();

  const app = new Hono();

  // -------------------------------------------------------------------------
  // Auth middleware — applied to every route.
  // -------------------------------------------------------------------------

  app.use("*", async (c, next) => {
    const header = c.req.header("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      return c.json(
        { error: "missing or malformed authorization header" },
        401,
      );
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
  // hand off to the extension-backed callback (over the NMH socket).
  // Success returns 200; a thrown/rejected callback is surfaced as 502 so
  // the daemon can tell "bad request" apart from "extension failed to post
  // the message".
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
    const previousChat = chatChain;
    let releaseChatChain!: () => void;
    chatChain = new Promise<void>((resolve) => {
      releaseChatChain = resolve;
    });
    await previousChat;

    try {
      await onSendChat(parsed.data.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ sent: false, error: message }, 502);
    } finally {
      releaseChatChain();
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

    // Serialize against every in-flight stream, not just one with the same
    // id. The bot owns a single shared pacat stdin (see audio-playback's
    // module-level singleton), so two concurrent POSTs with *different*
    // streamIds would race on `handle.write()` and produce interleaved
    // PCM. Semantics: last-writer-wins — a fresh POST pre-empts whatever
    // is playing.
    //
    // Step 1: abort every currently-registered stream so any in-flight
    //         writer exits its read loop at the next iteration.
    // Step 2: splice a fresh completion promise into `playbackChain` *now*
    //         (before awaiting) so a later POST that arrives while we're
    //         still waiting queues behind us, not beside us. Without the
    //         splice two concurrent arrivals could both await the same
    //         prior chain tail and then both start writing in parallel.
    // Step 3: await the previous chain tail so the prior handler's
    //         trailing-silence flush has landed before we touch
    //         `handle.write()`.
    for (const prior of activeStreams.values()) {
      prior.controller.abort();
    }
    const previousChain = playbackChain;
    let releaseChain!: () => void;
    playbackChain = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    // `previousChain` never rejects — all handlers below resolve their
    // slot in a `finally`, and silence-flush errors are swallowed — so
    // awaiting it directly is safe.
    await previousChain;

    try {
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
        if (activeStreams.get(streamId)?.controller === controller) {
          activeStreams.delete(streamId);
        }
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
        if (activeStreams.get(streamId)?.controller === controller) {
          activeStreams.delete(streamId);
        }
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
    } finally {
      releaseChain();
    }
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
  // POST /avatar/viseme — forward a viseme event to the active renderer.
  //
  // Body shape must match `VisemeEvent` from
  // `../media/avatar/types.ts` — the same shape the daemon's
  // `tts-lipsync.ts` forwarder POSTs. When no renderer is active (the
  // feature is off, or `/avatar/enable` has not yet been called), the
  // event is dropped with a 200 so the forwarder doesn't buffer /
  // retry. When the active renderer advertises `needsVisemes: false`,
  // the event is similarly dropped without calling the renderer — the
  // drop is cheap enough that the branch is just a belt-and-suspenders
  // gate in case a renderer forgets to self-check.
  // -------------------------------------------------------------------------

  app.post("/avatar/viseme", async (c) => {
    const body = await readJson(c);
    const parsed = parseVisemeEvent(body);
    if (!parsed) {
      return c.json({ error: "invalid viseme event body" }, 400);
    }
    // Drop silently when the renderer isn't active. Keeping a 200 here
    // means the daemon's fire-and-forget forwarder doesn't flood retry
    // traffic against a bot that simply hasn't flipped the renderer on.
    if (!avatarRenderer) {
      return c.json({ dispatched: false }, 200);
    }
    if (!avatarRenderer.capabilities.needsVisemes) {
      return c.json({ dispatched: false }, 200);
    }
    try {
      avatarRenderer.pushViseme(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        { dispatched: false, error: `pushViseme threw: ${message}` },
        500,
      );
    }
    return c.json({ dispatched: true }, 200);
  });

  // -------------------------------------------------------------------------
  // POST /avatar/enable — start the configured renderer + attach the
  // device writer. Concurrency-safe via `avatarMutationChain` so racing
  // enables don't produce two live renderers on one device.
  // -------------------------------------------------------------------------

  app.post("/avatar/enable", async (c) => {
    if (!avatar) {
      return c.json(
        {
          enabled: false,
          error: "avatar subsystem disabled (AVATAR_ENABLED not set)",
        },
        503,
      );
    }
    const previous = avatarMutationChain;
    let release!: (v: unknown) => void;
    avatarMutationChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
    } catch {
      // A prior mutation failed; we still hold the lock and can proceed.
    }
    try {
      // Idempotent: if a renderer is already running, just return
      // success so the daemon's retry path doesn't thrash the device.
      if (avatarRenderer) {
        return c.json(
          {
            enabled: true,
            renderer: avatarRenderer.id,
            alreadyRunning: true,
          },
          200,
        );
      }

      let renderer: AvatarRenderer | null;
      try {
        const resolveFn =
          avatar.resolveRenderer ??
          ((config) =>
            resolveAvatarRenderer(config, {
              ...(avatar.nativeMessaging
                ? { nativeMessaging: avatar.nativeMessaging }
                : {}),
            }));
        renderer = resolveFn(avatar.config);
      } catch (err) {
        if (err instanceof AvatarRendererUnavailableError) {
          return c.json(
            {
              enabled: false,
              renderer: err.rendererId,
              error: err.reason,
            },
            503,
          );
        }
        throw err;
      }

      // `null` means "noop / disabled at config level" — return 200
      // because the feature is behaving as configured. No device
      // attachment happens, and the bot's camera track stays absent
      // (identical to phase 3 behavior).
      if (!renderer) {
        return c.json(
          {
            enabled: true,
            renderer: "noop",
            active: false,
          },
          200,
        );
      }

      // Start the renderer BEFORE opening the device so a
      // construction-time `AvatarRendererUnavailableError` thrown
      // from `start()` doesn't leak a held file descriptor.
      try {
        await renderer.start();
      } catch (err) {
        if (err instanceof AvatarRendererUnavailableError) {
          return c.json(
            {
              enabled: false,
              renderer: err.rendererId,
              error: err.reason,
            },
            503,
          );
        }
        throw err;
      }

      const openDeviceFn = avatar.openDevice ?? defaultOpenVideoDevice;
      let deviceHandle: VideoDeviceHandle;
      try {
        deviceHandle = avatar.devicePath
          ? await openDeviceFn(avatar.devicePath)
          : await openDeviceFn("/dev/video10");
      } catch (err) {
        // If the device couldn't be opened, tear the renderer down so
        // we don't leak a live GPU session or tab.
        await renderer.stop().catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          {
            enabled: false,
            renderer: renderer.id,
            error: `failed to open avatar device: ${message}`,
          },
          503,
        );
      }

      const writer = attachDeviceWriter({
        renderer,
        sink: deviceHandle.sink,
        maxFps: avatar.maxFps,
      });

      avatarRenderer = renderer;
      avatarDeviceHandle = deviceHandle;
      avatarDeviceWriter = writer;

      // Flip the Meet camera toggle ON so other participants start
      // receiving frames from `/dev/video10` (now fed by the renderer).
      // Ordered AFTER renderer start + device attach so the moment the
      // toggle flips the camera ON, Meet reads real frames instead of a
      // black frame. Non-fatal on failure: a stuck camera toggle is a
      // regression signal but tearing the renderer back down would be
      // strictly worse — the device is attached, the renderer is
      // running, and the next `/avatar/enable` retry or a manual user
      // click can recover.
      let cameraChange: { changed: boolean } | null = null;
      let cameraError: string | null = null;
      if (avatar.camera) {
        try {
          cameraChange = await avatar.camera.enableCamera();
        } catch (err) {
          cameraError = err instanceof Error ? err.message : String(err);
        }
      }

      const body: Record<string, unknown> = {
        enabled: true,
        renderer: renderer.id,
        active: true,
        devicePath: deviceHandle.devicePath,
      };
      if (cameraChange !== null) {
        body.cameraChanged = cameraChange.changed;
      }
      if (cameraError !== null) {
        body.cameraError = cameraError;
      }
      return c.json(body, 200);
    } finally {
      release(undefined);
    }
  });

  // -------------------------------------------------------------------------
  // POST /avatar/disable — detach the writer, stop the renderer, close
  // the device. Idempotent: returns 200 even when nothing is running.
  // -------------------------------------------------------------------------

  app.post("/avatar/disable", async (c) => {
    if (!avatar) {
      return c.json(
        {
          disabled: true,
          reason: "avatar subsystem disabled (AVATAR_ENABLED not set)",
        },
        200,
      );
    }
    const previous = avatarMutationChain;
    let release!: (v: unknown) => void;
    avatarMutationChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
    } catch {
      /* previous mutation error; proceed with teardown */
    }
    try {
      const writer = avatarDeviceWriter;
      const device = avatarDeviceHandle;
      const renderer = avatarRenderer;

      avatarDeviceWriter = null;
      avatarDeviceHandle = null;
      avatarRenderer = null;

      // Flip the camera OFF BEFORE tearing down the renderer so other
      // participants stop seeing the video track before the frame source
      // disappears — this avoids the brief black frame gap that would
      // otherwise appear while the renderer/device teardown is in
      // flight. Non-fatal on failure; we still complete teardown so the
      // device doesn't hold open a handle.
      let cameraChange: { changed: boolean } | null = null;
      let cameraError: string | null = null;
      if (avatar.camera) {
        try {
          cameraChange = await avatar.camera.disableCamera();
        } catch (err) {
          cameraError = err instanceof Error ? err.message : String(err);
        }
      }

      // Teardown order (reverse of setup): writer → device → renderer.
      if (writer) {
        try {
          writer.stop();
        } catch {
          /* best-effort */
        }
      }
      if (device) {
        await device.close().catch(() => {
          /* best-effort */
        });
      }
      if (renderer) {
        await renderer.stop().catch(() => {
          /* best-effort */
        });
      }

      const body: Record<string, unknown> = {
        disabled: true,
        wasActive: renderer !== null,
      };
      if (cameraChange !== null) {
        body.cameraChanged = cameraChange.changed;
      }
      if (cameraError !== null) {
        body.cameraError = cameraError;
      }
      return c.json(body, 200);
    } finally {
      release(undefined);
    }
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

/**
 * Validate `/avatar/viseme` request bodies against the `VisemeEvent`
 * shape declared in `../media/avatar/types.ts` without bringing zod
 * into the bot's runtime surface. The avatar module is deliberately
 * schema-free (it's shared with hosted renderer factories that may
 * run in sandboxed environments), so we hand-roll the predicate here.
 *
 * Accepts `phoneme: string`, `weight: number`, `timestamp: number`.
 * Returns `null` for any shape mismatch so the route can reply with a
 * generic 400 — the daemon's `tts-lipsync.ts` forwarder already tolerates
 * 4xx/5xx from this route, so surfacing specific issues isn't worth the
 * extra surface.
 */
function parseVisemeEvent(body: unknown): VisemeEvent | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.phoneme !== "string") return null;
  if (typeof raw.weight !== "number" || !Number.isFinite(raw.weight)) {
    return null;
  }
  if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) {
    return null;
  }
  return {
    phoneme: raw.phoneme,
    weight: raw.weight,
    timestamp: raw.timestamp,
  };
}
