/**
 * Tests for `runBot` — the boot path that wires pulse → xvfb → browser →
 * joinMeet → daemon client → scrapers → audio → http server.
 *
 * We don't spin up a real browser or daemon here. Every subsystem is
 * stubbed with a recording mock that lets us assert on:
 *
 *   - Boot order (each subsystem only starts after its prerequisites).
 *   - Callback wiring (scraper `onEvent` calls actually enqueue into the
 *     daemon client).
 *   - Shutdown ordering and dedup (SIGTERM + HTTP `/leave` don't double-stop).
 *   - Error paths (join failure publishes `lifecycle:error` and exits 1).
 *
 * The separate boot smoke test (`boot.test.ts`) still covers the
 * `SKIP_PULSE=1` + missing-MEET_URL path against a real `bun run src/main.ts`.
 */

import { describe, expect, test } from "bun:test";

import type { LifecycleEvent, MeetBotEvent } from "../../contracts/index.js";

import { runBot, type BotDeps, type DaemonClientLike } from "../src/main.js";
import { BotState } from "../src/control/state.js";

/** -----------------------------------------------------------------------
 * Mock factory
 * ----------------------------------------------------------------------- */

interface RecordedCall {
  kind: string;
  [k: string]: unknown;
}

interface MockHandles {
  /**
   * Recorded invocations in the order they were made — lets tests assert
   * on boot order.
   */
  calls: RecordedCall[];
  /** Events enqueued on the daemon client. */
  daemonEvents: MeetBotEvent[];
  /** Whether the daemon client was ever `stop`ped. */
  daemonStopped: () => boolean;
  /** Latest log messages, stderr-side. */
  errors: string[];
  /** Latest log messages, stdout-side. */
  infos: string[];
  /** Latest exit code, if exit was called. */
  exitCode: () => number | null;
  /** Invoke the SIGTERM handler captured during boot. */
  fireSigterm: () => void;
  /** Invoke the SIGINT handler captured during boot. */
  fireSigint: () => void;
  /**
   * Fire the `onError` hook the `runBot` passed into `createDaemonClient`.
   * Returns `null` if the daemon client hasn't been constructed yet.
   */
  fireDaemonError: (err: Error) => void;
  /** Page object the scrapers see. */
  page: object;
  /** HTTP callbacks the server captured. */
  httpCallbacks: () => {
    onLeave: (reason: string | undefined) => void | Promise<void>;
  } | null;
  /** Sessions created — primarily for asserting `close()` was called. */
  sessionCloses: () => number;
  /** Participant/speaker/chat/audio stop counters. */
  stopCounts: () => {
    participant: number;
    speaker: number;
    chat: number;
    audio: number;
    httpServer: number;
  };
}

interface MakeDepsOpts {
  /** Force `joinMeet` to reject with this error. */
  joinError?: Error;
  /** Force `setupPulseAudio` to reject. */
  pulseError?: Error;
}

function makeDeps(opts: MakeDepsOpts = {}): {
  deps: BotDeps;
  handles: MockHandles;
} {
  const calls: RecordedCall[] = [];
  const daemonEvents: MeetBotEvent[] = [];
  let daemonStopped = false;
  const errors: string[] = [];
  const infos: string[] = [];
  let exitCode: number | null = null;

  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  let sessionClosed = 0;
  let participantStops = 0;
  let speakerStops = 0;
  let chatStops = 0;
  let audioStops = 0;
  let httpStops = 0;

  let capturedHttpCallbacks: {
    onLeave: (reason: string | undefined) => void | Promise<void>;
  } | null = null;

  let capturedDaemonOnError: ((err: Error) => void) | null = null;

  const fakePage = { __fake: true };

  // Full skipPulse default so only opt-in tests exercise the pulse path.
  const defaultEnv = {
    meetUrl: "https://meet.google.com/abc-defg-hij",
    meetingId: "m-1",
    joinName: "Vellum Bot",
    consentMessage: "Hi, I'm an AI assistant listening in.",
    daemonUrl: "http://daemon.local:7000",
    botApiToken: "secret",
    socketDir: "/sockets",
    skipPulse: true,
    httpPort: 0,
  };

  const daemonClient: DaemonClientLike = {
    enqueue: (event) => {
      calls.push({ kind: "daemon.enqueue", event });
      daemonEvents.push(event);
    },
    flush: async () => {
      calls.push({ kind: "daemon.flush" });
    },
    stop: async () => {
      daemonStopped = true;
      calls.push({ kind: "daemon.stop" });
    },
  };

  const deps: BotDeps = {
    env: () => ({ ...defaultEnv }),
    setupPulseAudio: async () => {
      calls.push({ kind: "pulse.setup" });
      if (opts.pulseError) throw opts.pulseError;
    },
    createBrowserSession: async (url) => {
      calls.push({ kind: "browser.create", url });
      return {
        browser: {} as never,
        context: {} as never,
        page: fakePage as never,
        close: async () => {
          sessionClosed += 1;
          calls.push({ kind: "browser.close" });
        },
      };
    },
    joinMeet: async (page, joinOpts) => {
      calls.push({
        kind: "join.meet",
        page,
        displayName: joinOpts.displayName,
        consentMessage: joinOpts.consentMessage,
      });
      if (opts.joinError) throw opts.joinError;
    },
    startParticipantScraper: (_page, _onEvent, scraperOpts) => {
      calls.push({
        kind: "scraper.participant.start",
        meetingId: scraperOpts.meetingId,
        selfName: scraperOpts.selfName,
      });
      return {
        stop: () => {
          participantStops += 1;
          calls.push({ kind: "scraper.participant.stop" });
        },
      };
    },
    startSpeakerScraper: (_page, _onEvent, scraperOpts) => {
      calls.push({
        kind: "scraper.speaker.start",
        meetingId: scraperOpts.meetingId,
      });
      return {
        stop: () => {
          speakerStops += 1;
          calls.push({ kind: "scraper.speaker.stop" });
        },
      };
    },
    startChatReader: async (_page, _onEvent, scraperOpts) => {
      calls.push({
        kind: "scraper.chat.start",
        meetingId: scraperOpts.meetingId,
        selfName: scraperOpts.selfName,
      });
      return {
        stop: async () => {
          chatStops += 1;
          calls.push({ kind: "scraper.chat.stop" });
        },
      };
    },
    startAudioCapture: async (audioOpts) => {
      calls.push({ kind: "audio.start", socketPath: audioOpts.socketPath });
      return {
        stop: async () => {
          audioStops += 1;
          calls.push({ kind: "audio.stop" });
        },
      };
    },
    sendChat: async (_page, text) => {
      calls.push({ kind: "sendChat", text });
    },
    createDaemonClient: (clientOpts) => {
      calls.push({
        kind: "daemon.create",
        daemonUrl: clientOpts.daemonUrl,
        meetingId: clientOpts.meetingId,
      });
      capturedDaemonOnError = clientOpts.onError;
      return daemonClient;
    },
    createHttpServer: (serverOpts) => {
      calls.push({
        kind: "http.create",
        apiToken: serverOpts.apiToken,
      });
      capturedHttpCallbacks = {
        onLeave: serverOpts.onLeave,
      };
      return {
        app: {} as never,
        start: async (port: number) => {
          calls.push({ kind: "http.start", port });
          return { port };
        },
        stop: async () => {
          httpStops += 1;
          calls.push({ kind: "http.stop" });
        },
      };
    },
    onSignal: (signal, handler) => {
      if (signal === "SIGTERM") sigtermHandler = handler;
      else sigintHandler = handler;
      return () => {
        if (signal === "SIGTERM" && sigtermHandler === handler) {
          sigtermHandler = null;
        } else if (signal === "SIGINT" && sigintHandler === handler) {
          sigintHandler = null;
        }
      };
    },
    joinedSettleMs: 0, // tests don't need the real 2s wait.
    sleep: async (_ms: number) => {
      // no-op in tests.
    },
    exit: ((code: number) => {
      // Record the first exit code only — subsequent calls are
      // tolerated (production `process.exit` never returns, so the
      // bot's real flow never sees a double-exit, but in tests the
      // mocked `exit` returns normally and we occasionally race).
      if (exitCode === null) exitCode = code;
      // `process.exit`'s real return type is `never`; we narrow to
      // `never` via a non-returning path so the production code
      // compiles. In tests we don't want to throw (that would leak
      // unhandled rejections out of fire-and-forget `.then(exit)`
      // chains), so just `return undefined as never`.
      return undefined as never;
    }) as BotDeps["exit"],
    logInfo: (msg) => {
      infos.push(msg);
    },
    logError: (msg) => {
      errors.push(msg);
    },
  };

  const handles: MockHandles = {
    calls,
    daemonEvents,
    daemonStopped: () => daemonStopped,
    errors,
    infos,
    exitCode: () => exitCode,
    fireSigterm: () => {
      if (sigtermHandler) sigtermHandler();
    },
    fireSigint: () => {
      if (sigintHandler) sigintHandler();
    },
    fireDaemonError: (err: Error) => {
      if (!capturedDaemonOnError) {
        throw new Error(
          "daemon client onError not captured — did createDaemonClient run?",
        );
      }
      capturedDaemonOnError(err);
    },
    page: fakePage,
    httpCallbacks: () => capturedHttpCallbacks,
    sessionCloses: () => sessionClosed,
    stopCounts: () => ({
      participant: participantStops,
      speaker: speakerStops,
      chat: chatStops,
      audio: audioStops,
      httpServer: httpStops,
    }),
  };

  return { deps, handles };
}

/** Return the ordered list of `kind` tags from the recorded calls. */
function kinds(calls: RecordedCall[]): string[] {
  return calls.map((c) => c.kind);
}

/** -----------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------- */

describe("runBot — boot sequence", () => {
  test("wires subsystems in the correct order", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    const order = kinds(handles.calls);

    // The boot order the implementation promises: browser session,
    // daemon client (so we can report join failures), join, settle,
    // scrapers, audio, http.
    const indexOf = (kind: string): number => order.indexOf(kind);

    expect(indexOf("browser.create")).toBeGreaterThanOrEqual(0);
    expect(indexOf("daemon.create")).toBeGreaterThan(indexOf("browser.create"));
    expect(indexOf("join.meet")).toBeGreaterThan(indexOf("daemon.create"));
    expect(indexOf("scraper.participant.start")).toBeGreaterThan(
      indexOf("join.meet"),
    );
    expect(indexOf("scraper.speaker.start")).toBeGreaterThan(
      indexOf("join.meet"),
    );
    expect(indexOf("scraper.chat.start")).toBeGreaterThan(indexOf("join.meet"));
    expect(indexOf("audio.start")).toBeGreaterThan(
      indexOf("scraper.chat.start"),
    );
    expect(indexOf("http.create")).toBeGreaterThan(indexOf("audio.start"));
    expect(indexOf("http.start")).toBeGreaterThan(indexOf("http.create"));
  });

  test("publishes lifecycle:joining before joinMeet and :joined after", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => e.state);

    // We expect at least `joining` and `joined`. No `error` / `left` yet.
    expect(lifecycleStates).toContain("joining");
    expect(lifecycleStates).toContain("joined");
    expect(lifecycleStates).not.toContain("error");
    expect(lifecycleStates).not.toContain("left");

    // Ordering: joining comes before joined.
    const joiningIdx = lifecycleStates.indexOf("joining");
    const joinedIdx = lifecycleStates.indexOf("joined");
    expect(joiningIdx).toBeGreaterThanOrEqual(0);
    expect(joinedIdx).toBeGreaterThan(joiningIdx);
  });

  test("passes the meetingId and selfName through to the scrapers", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    const participantCall = handles.calls.find(
      (c) => c.kind === "scraper.participant.start",
    );
    const speakerCall = handles.calls.find(
      (c) => c.kind === "scraper.speaker.start",
    );
    const chatCall = handles.calls.find((c) => c.kind === "scraper.chat.start");

    expect(participantCall?.meetingId).toBe("m-1");
    expect(speakerCall?.meetingId).toBe("m-1");
    expect(chatCall?.meetingId).toBe("m-1");
    expect(chatCall?.selfName).toBe("Vellum Bot");
    // The participant scraper also receives the bot's display name so it
    // can flag the bot's own row with `isSelf: true`, letting the consent
    // monitor identify `botParticipantId` and filter self-content from
    // the watermark.
    expect(participantCall?.selfName).toBe("Vellum Bot");
  });

  test("passes socketDir/audio.sock into audio capture", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    const audioCall = handles.calls.find((c) => c.kind === "audio.start");
    expect(audioCall?.socketPath).toBe("/sockets/audio.sock");
  });
});

describe("runBot — shutdown", () => {
  test("onLeave triggers the full shutdown path in the right order", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    // Exercise the /leave path.
    const cbs = handles.httpCallbacks();
    expect(cbs).not.toBeNull();

    // onLeave schedules shutdown + exit via `void` — we catch the
    // sentinel exit() throw via the shutdown promise.
    await new Promise<void>((resolve) => {
      void (async () => {
        try {
          await cbs!.onLeave("user requested");
        } catch {
          // swallow __test_exit
        }
        resolve();
      })();
    });

    // Poll for shutdown completion — the exit-code sentinel lands after
    // the shutdown chain resolves.
    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(handles.exitCode()).toBe(0);

    const order = kinds(handles.calls);
    const leaveStart = order.lastIndexOf("http.create") + 1;
    const shutdownOrder = order.slice(leaveStart);

    // HTTP server stops first (no new commands after /leave).
    expect(shutdownOrder.indexOf("http.stop")).toBeGreaterThanOrEqual(0);
    // Then scrapers.
    expect(shutdownOrder.indexOf("scraper.participant.stop")).toBeGreaterThan(
      shutdownOrder.indexOf("http.stop"),
    );
    expect(shutdownOrder.indexOf("scraper.speaker.stop")).toBeGreaterThan(
      shutdownOrder.indexOf("http.stop"),
    );
    expect(shutdownOrder.indexOf("scraper.chat.stop")).toBeGreaterThan(
      shutdownOrder.indexOf("http.stop"),
    );
    // Audio before browser.
    expect(shutdownOrder.indexOf("audio.stop")).toBeGreaterThan(
      shutdownOrder.indexOf("scraper.chat.stop"),
    );
    expect(shutdownOrder.indexOf("browser.close")).toBeGreaterThan(
      shutdownOrder.indexOf("audio.stop"),
    );
    // Daemon stop comes last, and only after `lifecycle:left` is enqueued.
    expect(shutdownOrder.indexOf("daemon.stop")).toBeGreaterThan(
      shutdownOrder.indexOf("browser.close"),
    );

    // `lifecycle:left` was published before stop().
    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => e.state);
    expect(lifecycleStates).toContain("left");
    expect(lifecycleStates[lifecycleStates.length - 1]).toBe("left");

    // Shutdown counts: each subsystem stopped exactly once.
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.participant).toBe(1);
    expect(counts.speaker).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.audio).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
    expect(handles.sessionCloses()).toBe(1);
  });

  test("SIGTERM triggers the same shutdown path", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    handles.fireSigterm();

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(handles.exitCode()).toBe(0);
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.participant).toBe(1);
    expect(counts.speaker).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.audio).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
  });

  test("SIGTERM + /leave do not double-stop subsystems", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    handles.fireSigterm();
    const cbs = handles.httpCallbacks();
    try {
      await cbs!.onLeave("redundant");
    } catch {
      // swallow __test_exit
    }

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.participant).toBe(1);
    expect(counts.speaker).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.audio).toBe(1);
  });
});

describe("runBot — error paths", () => {
  test("join failure publishes lifecycle:error and exits 1", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      joinError: new Error("prejoin selector timed out"),
    });

    try {
      await runBot(deps);
    } catch (err) {
      // The sentinel exit() throws — catch so the test continues.
      const msg = (err as Error).message;
      if (!msg.startsWith("__test_exit")) throw err;
    }

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(handles.exitCode()).toBe(1);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    expect(lifecycleStates.some((s) => s.state === "error")).toBe(true);
    const errorEvent = lifecycleStates.find((s) => s.state === "error");
    expect(errorEvent?.detail).toContain("prejoin selector timed out");

    // Scrapers / audio / http must not have started.
    const order = kinds(handles.calls);
    expect(order).not.toContain("scraper.participant.start");
    expect(order).not.toContain("audio.start");
    expect(order).not.toContain("http.start");

    // Browser was closed; daemon was flushed.
    expect(handles.sessionCloses()).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
  });

  test("PulseAudio failure exits 1 without touching browser", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      pulseError: new Error("pulseaudio: connection refused"),
    });
    // Override skipPulse to force the setup call.
    const realEnv = deps.env;
    deps.env = () => ({ ...realEnv(), skipPulse: false });

    try {
      await runBot(deps);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.startsWith("__test_exit")) throw err;
    }

    expect(handles.exitCode()).toBe(1);
    const order = kinds(handles.calls);
    expect(order).toContain("pulse.setup");
    expect(order).not.toContain("browser.create");
    expect(
      handles.errors.some((e) => e.includes("PulseAudio setup failed")),
    ).toBe(true);
  });
});

describe("runBot — daemon-client terminal errors", () => {
  test("logs a single terminal error without shutting down", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    const stopsBefore = handles.stopCounts();
    const exitBefore = handles.exitCode();

    handles.fireDaemonError(new Error("ingress returned status 503"));

    // Give any fire-and-forget shutdown promise a chance to advance.
    await new Promise((r) => setTimeout(r, 20));

    // No shutdown yet — single transient failures are tolerated.
    const stopsAfter = handles.stopCounts();
    expect(stopsAfter.httpServer).toBe(stopsBefore.httpServer);
    expect(stopsAfter.participant).toBe(stopsBefore.participant);
    expect(stopsAfter.audio).toBe(stopsBefore.audio);
    expect(handles.daemonStopped()).toBe(false);
    expect(handles.exitCode()).toBe(exitBefore);

    // But the failure must have been surfaced to the log.
    expect(
      handles.errors.some((e) => e.includes("daemon ingress failure")),
    ).toBe(true);
    expect(handles.errors.some((e) => e.includes("status 503"))).toBe(true);
  });

  test("second terminal error within the window triggers graceful shutdown + exit 1", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    handles.fireDaemonError(
      new Error("ingress rejected batch with status 400"),
    );
    handles.fireDaemonError(new Error("ingress returned status 503"));

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Exited 1 (error) rather than 0 (clean leave).
    expect(handles.exitCode()).toBe(1);

    // Subsystems torn down exactly once — same dedup as SIGTERM / /leave.
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.participant).toBe(1);
    expect(counts.speaker).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.audio).toBe(1);
    expect(handles.daemonStopped()).toBe(true);

    // Final lifecycle event is "error" with the daemon-ingress detail.
    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const last = lifecycleStates[lifecycleStates.length - 1]!;
    expect(last.state).toBe("error");
    expect(last.detail).toContain("daemon ingress failure");

    // Both failures were logged, plus the "shutting down" banner.
    expect(
      handles.errors.filter((e) => e.includes("daemon ingress failure")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(handles.errors.some((e) => e.includes("shutting down"))).toBe(true);
  });

  test("daemon-error shutdown deduplicates against SIGTERM", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await runBot(deps);

    // Tip over the error threshold…
    handles.fireDaemonError(new Error("status 400"));
    handles.fireDaemonError(new Error("status 400"));

    // …and race a SIGTERM into the shutdown.
    handles.fireSigterm();

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Each subsystem stopped exactly once — the shutdown guard held.
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.participant).toBe(1);
    expect(counts.speaker).toBe(1);
    expect(counts.chat).toBe(1);
    expect(counts.audio).toBe(1);
  });
});

describe("runBot — event wiring", () => {
  test("scraper onEvent callbacks enqueue events on the daemon client", async () => {
    BotState.__resetForTests();

    // Capture the participant-scraper onEvent so we can invoke it by hand.
    let participantOnEvent:
      | ((
          event: import("../../contracts/index.js").ParticipantChangeEvent,
        ) => void)
      | null = null;
    let speakerOnEvent:
      | ((event: import("../../contracts/index.js").SpeakerChangeEvent) => void)
      | null = null;
    let chatOnEvent:
      | ((event: import("../../contracts/index.js").InboundChatEvent) => void)
      | null = null;

    const { deps, handles } = makeDeps();
    const baseStart = deps.startParticipantScraper;
    const baseSpeaker = deps.startSpeakerScraper;
    const baseChat = deps.startChatReader;

    deps.startParticipantScraper = (page, onEvent, opts) => {
      participantOnEvent = onEvent;
      return baseStart(page, onEvent, opts);
    };
    deps.startSpeakerScraper = (page, onEvent, opts) => {
      speakerOnEvent = onEvent;
      return baseSpeaker(page, onEvent, opts);
    };
    deps.startChatReader = (page, onEvent, opts) => {
      chatOnEvent = onEvent;
      return baseChat(page, onEvent, opts);
    };

    await runBot(deps);

    const before = handles.daemonEvents.length;
    expect(participantOnEvent).not.toBeNull();
    expect(speakerOnEvent).not.toBeNull();
    expect(chatOnEvent).not.toBeNull();

    participantOnEvent!({
      type: "participant.change",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      joined: [{ id: "p-1", name: "Alice" }],
      left: [],
    });
    speakerOnEvent!({
      type: "speaker.change",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      speakerId: "p-1",
      speakerName: "Alice",
    });
    chatOnEvent!({
      type: "chat.inbound",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      fromId: "p-2",
      fromName: "Bob",
      text: "hello",
    });

    expect(handles.daemonEvents.length).toBe(before + 3);
    const newEvents = handles.daemonEvents.slice(before);
    expect(newEvents.map((e) => e.type)).toEqual([
      "participant.change",
      "speaker.change",
      "chat.inbound",
    ]);
  });
});
