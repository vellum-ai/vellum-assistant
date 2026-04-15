/**
 * HTTP control surface for the meet-bot container.
 *
 * Exposes a small Hono app that the assistant daemon talks to:
 *
 *   - `GET  /health`     — liveness/health probe (also used by Docker HEALTHCHECK).
 *   - `GET  /status`     — full lifecycle snapshot.
 *   - `POST /leave`      — ask the bot to leave the meeting.
 *   - `POST /send_chat`  — post a chat message into the Meet chat panel.
 *   - `POST /play_audio` — play an out-of-band audio stream (Phase 3; stub 501).
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
   * Called when `POST /play_audio` is received. Currently a stub — the HTTP
   * route returns 501. The real PCM stream is delivered out of band
   * (chunked transfer in Phase 3); this callback will eventually be handed
   * just the metadata.
   */
  onPlayAudio: (streamId: string) => Promise<void> | void;
}

export interface CreateHttpServerOptions extends HttpServerCallbacks {
  /** Bearer token required on every request. */
  apiToken: string;
}

export interface HttpServerHandle {
  /** The underlying Hono app — exposed for tests that want to call `fetch`. */
  readonly app: Hono;
  /** Start listening on the given port. Pass `0` to pick a random free port. */
  start: (port: number) => Promise<{ port: number }>;
  /** Stop the listener (no-op if never started). */
  stop: () => Promise<void>;
}

/** Build (but do not start) the HTTP server. */
export function createHttpServer(
  options: CreateHttpServerOptions,
): HttpServerHandle {
  const { apiToken, onLeave, onSendChat, onPlayAudio } = options;

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
  // POST /play_audio — pure stub until Phase 3 lands.
  // -------------------------------------------------------------------------

  app.post("/play_audio", async (c) => {
    // We don't validate the body here — the stream metadata shape may still
    // change when the Phase 3 audio channel lands. The callback is invoked
    // with a placeholder so its signature can stabilize in tests.
    void Promise.resolve(onPlayAudio("")).catch(() => {});
    return c.json({ error: "not implemented" }, 501);
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
