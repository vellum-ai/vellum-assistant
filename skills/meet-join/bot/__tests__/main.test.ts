/**
 * Tests for `runBot` — the boot path that wires pulse → xvfb → NMH socket
 * server → Chrome subprocess + extension → extension-ready handshake →
 * join command → audio → HTTP server.
 *
 * We don't spin up a real browser, real socket, or real Xvfb here. Every
 * subsystem is stubbed with a recording mock that lets us assert on:
 *
 *   - Boot order (each subsystem only starts after its prerequisites).
 *   - Extension-message routing (participant/speaker/chat forward to
 *     daemon; send_chat_result resolves pending HTTP promises).
 *   - Shutdown ordering and dedup (SIGTERM + HTTP `/leave` don't double-stop).
 *   - Error paths (extension never signals ready, Chrome exits early,
 *     daemon-client flap).
 *
 * The separate boot smoke test (`boot.test.ts`) still covers the
 * `SKIP_PULSE=1` + missing-MEET_URL path against a real `bun run src/main.ts`.
 */

import { describe, expect, test } from "bun:test";

import type { LifecycleEvent, MeetBotEvent } from "../../contracts/index.js";
import type {
  BotToExtensionMessage,
  ExtensionToBotMessage,
} from "../../contracts/native-messaging.js";

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
  /** Recorded invocations in order — lets tests assert on boot order. */
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
   * Fire the `onError` hook that `runBot` passed into `createDaemonClient`.
   * Returns `null` if the daemon client hasn't been constructed yet.
   */
  fireDaemonError: (err: Error) => void;
  /** Deliver a message to the socket-server's `onExtensionMessage` listeners. */
  fireExtensionMessage: (msg: ExtensionToBotMessage) => void;
  /** Resolve the socket-server's pending `waitForReady` promise. */
  fireExtensionReady: () => void;
  /** Reject the socket-server's pending `waitForReady` promise. */
  failExtensionReady: (err: Error) => void;
  /** Resolve the Chrome exit promise (e.g. to simulate an unexpected exit). */
  fireChromeExit: (code: number) => void;
  /** HTTP callbacks the server captured. */
  httpCallbacks: () => {
    onLeave: (reason: string | undefined) => void | Promise<void>;
    onSendChat: (text: string) => Promise<void> | void;
  } | null;
  /** Inspect queued outbound messages sent to the extension. */
  outboundMessages: () => BotToExtensionMessage[];
  /** Shutdown counters for each subsystem (one per subsystem). */
  stopCounts: () => {
    xvfb: number;
    socketServer: number;
    chrome: number;
    audio: number;
    httpServer: number;
  };
}

interface MakeDepsOpts {
  /** Force `setupPulseAudio` to reject. */
  pulseError?: Error;
  /** Force `launchChrome` to reject. */
  chromeLaunchError?: Error;
  /** Force `xdotoolClick` to reject. */
  xdotoolClickError?: Error;
  /** Force `xdotoolType` to reject. */
  xdotoolTypeError?: Error;
  /** Force `startXvfb` to reject. */
  xvfbError?: Error;
  /** Short-circuit `waitForReady` to reject with this error. */
  extensionReadyError?: Error;
  /**
   * Deadline for the extension to reach `lifecycle:joined`. Defaults to
   * a very large value in tests so the happy-path suite doesn't trip the
   * timer while sitting at `phase=joining`. Only the Gap B test should
   * override this to a small value.
   */
  extensionJoinedTimeoutMs?: number;
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

  let xvfbStops = 0;
  let socketStops = 0;
  let chromeStops = 0;
  let audioStops = 0;
  let httpStops = 0;

  let capturedHttpCallbacks: {
    onLeave: (reason: string | undefined) => void | Promise<void>;
    onSendChat: (text: string) => Promise<void> | void;
  } | null = null;

  let capturedDaemonOnError: ((err: Error) => void) | null = null;

  // ---- socket server plumbing ------------------------------------------
  const outbound: BotToExtensionMessage[] = [];
  const extensionListeners: Array<(msg: ExtensionToBotMessage) => void> = [];
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  // ---- chrome plumbing -------------------------------------------------
  let chromeExitResolve: ((code: number) => void) | null = null;
  const chromeExitPromise = new Promise<number>((resolve) => {
    chromeExitResolve = resolve;
  });

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
    extensionPath: "/app/ext",
    nmhSocketPath: "/run/nmh.sock",
    xvfbDisplay: ":99",
    chromeUserDataRoot: "/tmp/chrome-profile",
    avatarEnabled: false,
    avatarRenderer: "noop",
    avatarConfigJson: undefined,
    avatarDevicePath: undefined,
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

  let requestIdCounter = 0;

  const deps: BotDeps = {
    env: () => ({ ...defaultEnv }),
    setupPulseAudio: async () => {
      calls.push({ kind: "pulse.setup" });
      if (opts.pulseError) throw opts.pulseError;
    },
    startXvfb: async (display) => {
      calls.push({ kind: "xvfb.start", display });
      if (opts.xvfbError) throw opts.xvfbError;
      return { display, process: null };
    },
    stopXvfb: async () => {
      xvfbStops += 1;
      calls.push({ kind: "xvfb.stop" });
    },
    createNmhSocketServer: (socketOpts) => {
      calls.push({ kind: "socket.create", socketPath: socketOpts.socketPath });
      return {
        start: async () => {
          calls.push({ kind: "socket.start" });
        },
        stop: async () => {
          socketStops += 1;
          calls.push({ kind: "socket.stop" });
          // Reject any lingering waitForReady so promise consumers unblock.
          if (readyReject) {
            readyReject(new Error("socket.stop reached before ready"));
            readyResolve = null;
            readyReject = null;
          }
        },
        sendToExtension: (msg) => {
          outbound.push(msg);
          calls.push({ kind: "socket.send", msg });
        },
        onExtensionMessage: (cb) => {
          extensionListeners.push(cb);
        },
        waitForReady: (_timeoutMs) => {
          calls.push({ kind: "socket.waitForReady" });
          return new Promise<void>((resolve, reject) => {
            if (opts.extensionReadyError) {
              reject(opts.extensionReadyError);
              return;
            }
            readyResolve = resolve;
            readyReject = reject;
          });
        },
      };
    },
    launchChrome: async (chromeOpts) => {
      calls.push({
        kind: "chrome.launch",
        meetingUrl: chromeOpts.meetingUrl,
        extensionPath: chromeOpts.extensionPath,
        displayNumber: chromeOpts.displayNumber,
        userDataDir: chromeOpts.userDataDir,
        avatarEnabled: chromeOpts.avatarEnabled,
        avatarDevicePath: chromeOpts.avatarDevicePath,
      });
      if (opts.chromeLaunchError) throw opts.chromeLaunchError;
      return {
        pid: 424242,
        stop: async () => {
          chromeStops += 1;
          calls.push({ kind: "chrome.stop" });
          // Resolve the exit promise now so any waiter inside runBot settles.
          if (chromeExitResolve) {
            chromeExitResolve(0);
            chromeExitResolve = null;
          }
        },
        exitPromise: chromeExitPromise,
      };
    },
    xdotoolClick: async (clickOpts) => {
      calls.push({
        kind: "xdotool.click",
        x: clickOpts.x,
        y: clickOpts.y,
        display: clickOpts.display,
      });
      if (opts.xdotoolClickError) throw opts.xdotoolClickError;
    },
    xdotoolType: async (typeOpts) => {
      calls.push({
        kind: "xdotool.type",
        text: typeOpts.text,
        delayMs: typeOpts.delayMs,
        display: typeOpts.display,
      });
      if (opts.xdotoolTypeError) throw opts.xdotoolTypeError;
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
        onSendChat: serverOpts.onSendChat,
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
    ensureDir: (path: string) => {
      calls.push({ kind: "ensureDir", path });
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
    joinedSettleMs: 0,
    sleep: async (_ms: number) => {
      // no-op in tests.
    },
    exit: ((code: number) => {
      if (exitCode === null) exitCode = code;
      return undefined as never;
    }) as BotDeps["exit"],
    logInfo: (msg) => {
      infos.push(msg);
    },
    logError: (msg) => {
      errors.push(msg);
    },
    extensionReadyTimeoutMs: 1_000,
    extensionJoinedTimeoutMs: opts.extensionJoinedTimeoutMs ?? 60_000,
    sendChatTimeoutMs: 500,
    leaveGraceMs: 0,
    generateRequestId: () => {
      requestIdCounter += 1;
      return `req-${requestIdCounter}`;
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
    fireExtensionMessage: (msg) => {
      for (const cb of extensionListeners) cb(msg);
    },
    fireExtensionReady: () => {
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
        readyReject = null;
      }
    },
    failExtensionReady: (err: Error) => {
      if (readyReject) {
        readyReject(err);
        readyResolve = null;
        readyReject = null;
      }
    },
    fireChromeExit: (code) => {
      if (chromeExitResolve) {
        chromeExitResolve(code);
        chromeExitResolve = null;
      }
    },
    httpCallbacks: () => capturedHttpCallbacks,
    outboundMessages: () => outbound.slice(),
    stopCounts: () => ({
      xvfb: xvfbStops,
      socketServer: socketStops,
      chrome: chromeStops,
      audio: audioStops,
      httpServer: httpStops,
    }),
  };

  return { deps, handles };
}

/**
 * Run `runBot` and fire the extension-ready handshake so the boot can
 * progress past `waitForReady`. Returns the `runBot` promise so tests can
 * await the full boot to complete (including settling the happy-path
 * `audio.start` / `http.start` / logs).
 */
async function bootHappyPath(
  deps: BotDeps,
  handles: MockHandles,
): Promise<void> {
  const running = runBot(deps);
  // Give the boot a tick to reach `waitForReady`, then fire ready.
  await new Promise((r) => setTimeout(r, 5));
  handles.fireExtensionReady();
  await running;
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
    await bootHappyPath(deps, handles);

    const order = kinds(handles.calls);
    const indexOf = (kind: string): number => order.indexOf(kind);

    // Expected boot order:
    //   xvfb → ensureDir (socket + profile) → socket.create → socket.start
    //   → daemon.create → chrome.launch → waitForReady → send `join`
    //   → audio.start → http.create → http.start.
    expect(indexOf("xvfb.start")).toBeGreaterThanOrEqual(0);
    expect(indexOf("socket.create")).toBeGreaterThan(indexOf("xvfb.start"));
    expect(indexOf("socket.start")).toBeGreaterThan(indexOf("socket.create"));
    expect(indexOf("daemon.create")).toBeGreaterThan(indexOf("socket.start"));
    expect(indexOf("chrome.launch")).toBeGreaterThan(indexOf("daemon.create"));
    expect(indexOf("socket.waitForReady")).toBeGreaterThan(
      indexOf("chrome.launch"),
    );
    expect(indexOf("socket.send")).toBeGreaterThan(
      indexOf("socket.waitForReady"),
    );
    expect(indexOf("audio.start")).toBeGreaterThan(indexOf("socket.send"));
    expect(indexOf("http.create")).toBeGreaterThan(indexOf("audio.start"));
    expect(indexOf("http.start")).toBeGreaterThan(indexOf("http.create"));
  });

  test("sends a `join` command with the env-provided URL + display name", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const outbound = handles.outboundMessages();
    const join = outbound.find((m) => m.type === "join");
    expect(join).toBeDefined();
    if (join && join.type === "join") {
      expect(join.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
      expect(join.displayName).toBe("Vellum Bot");
      expect(join.consentMessage).toBe("Hi, I'm an AI assistant listening in.");
    }
  });

  test("publishes lifecycle:joining to the daemon after sending join", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => e.state);

    expect(lifecycleStates).toContain("joining");
    // No `joined` yet — the extension hasn't emitted its own joined event.
    expect(lifecycleStates).not.toContain("left");
    expect(lifecycleStates).not.toContain("error");
  });

  test("audio capture uses socketDir/audio.sock", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const audioCall = handles.calls.find((c) => c.kind === "audio.start");
    expect(audioCall?.socketPath).toBe("/sockets/audio.sock");
  });
});

describe("runBot — extension message routing", () => {
  test("extension lifecycle:joined forwards to the daemon", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "lifecycle",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      state: "joined",
    });

    const after = handles.daemonEvents.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe("lifecycle");
    if (after[0]?.type === "lifecycle") {
      expect(after[0].state).toBe("joined");
    }
  });

  test("participant.change forwards to the daemon verbatim", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "participant.change",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      joined: [{ id: "p-1", name: "Alice" }],
      left: [],
    });

    const after = handles.daemonEvents.slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe("participant.change");
  });

  test("speaker.change and chat.inbound both forward to the daemon", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "speaker.change",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      speakerId: "p-1",
      speakerName: "Alice",
    });
    handles.fireExtensionMessage({
      type: "chat.inbound",
      meetingId: "m-1",
      timestamp: new Date().toISOString(),
      fromId: "p-2",
      fromName: "Bob",
      text: "hello",
    });

    const after = handles.daemonEvents.slice(before);
    expect(after.map((e) => e.type)).toEqual([
      "speaker.change",
      "chat.inbound",
    ]);
  });

  test("trusted_click invokes xdotoolClick with the screen coords + configured display", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    handles.fireExtensionMessage({
      type: "trusted_click",
      x: 1014,
      y: 536,
    });
    // xdotoolClick is fire-and-forget (no promise surface here), so give
    // it one microtask to settle and the logInfo to land.
    await new Promise((r) => setTimeout(r, 10));

    const clickCall = handles.calls.find((c) => c.kind === "xdotool.click");
    expect(clickCall).toBeDefined();
    expect(clickCall!.x).toBe(1014);
    expect(clickCall!.y).toBe(536);
    expect(clickCall!.display).toBe(":99");
    // Success should surface via logInfo.
    expect(
      handles.infos.some((m) =>
        m.includes("trusted_click dispatched at (1014,536)"),
      ),
    ).toBe(true);
  });

  test("trusted_click xdotool failures surface via logError but don't shut down", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      xdotoolClickError: new Error("xdotool exit code 1"),
    });
    await bootHappyPath(deps, handles);

    handles.fireExtensionMessage({ type: "trusted_click", x: 5, y: 10 });
    await new Promise((r) => setTimeout(r, 10));

    expect(
      handles.errors.some((m) =>
        m.includes("trusted_click failed: xdotool exit code 1"),
      ),
    ).toBe(true);
    // Bot stays alive — no shutdown triggered.
    const counts = handles.stopCounts();
    expect(counts.chrome).toBe(0);
    expect(counts.xvfb).toBe(0);
  });

  test("trusted_type invokes xdotoolType with the payload + configured display", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    handles.fireExtensionMessage({
      type: "trusted_type",
      text: "hello world",
      delayMs: 25,
    });
    // xdotoolType is fire-and-forget (same pattern as trusted_click), so
    // give it a microtask to settle and the logInfo to land.
    await new Promise((r) => setTimeout(r, 10));

    const typeCall = handles.calls.find((c) => c.kind === "xdotool.type");
    expect(typeCall).toBeDefined();
    expect(typeCall!.text).toBe("hello world");
    expect(typeCall!.delayMs).toBe(25);
    expect(typeCall!.display).toBe(":99");
    // Success should surface via logInfo with the character count.
    expect(
      handles.infos.some((m) =>
        m.includes("trusted_type dispatched (11 chars)"),
      ),
    ).toBe(true);
  });

  test("trusted_type xdotool failures surface via logError but don't shut down", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      xdotoolTypeError: new Error("xdotool type exit code 1"),
    });
    await bootHappyPath(deps, handles);

    handles.fireExtensionMessage({
      type: "trusted_type",
      text: "fail me",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(
      handles.errors.some((m) =>
        m.includes("trusted_type failed: xdotool type exit code 1"),
      ),
    ).toBe(true);
    // Bot stays alive — no shutdown triggered.
    const counts = handles.stopCounts();
    expect(counts.chrome).toBe(0);
    expect(counts.xvfb).toBe(0);
  });

  test("diagnostic messages go through the logger, not the daemon", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const beforeEvents = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "diagnostic",
      level: "info",
      message: "content-script loaded",
    });
    handles.fireExtensionMessage({
      type: "diagnostic",
      level: "error",
      message: "selector timed out",
    });

    // No daemon events for diagnostics.
    expect(handles.daemonEvents.length).toBe(beforeEvents);
    expect(handles.infos.some((m) => m.includes("content-script loaded"))).toBe(
      true,
    );
    expect(handles.errors.some((m) => m.includes("selector timed out"))).toBe(
      true,
    );
  });
});

describe("runBot — send_chat HTTP path", () => {
  test("send_chat routes through the socket server with a requestId", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const cbs = handles.httpCallbacks();
    expect(cbs).not.toBeNull();

    const before = handles.outboundMessages().length;
    const sendPromise = Promise.resolve(cbs!.onSendChat("hello world"));
    // Give the dispatch a tick to land on the socket.
    await new Promise((r) => setTimeout(r, 5));

    const outbound = handles.outboundMessages();
    const fresh = outbound.slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.type).toBe("send_chat");
    const firstReq = fresh[0];
    if (firstReq && firstReq.type === "send_chat") {
      expect(firstReq.text).toBe("hello world");
      expect(typeof firstReq.requestId).toBe("string");
      // Resolve the send_chat_result for that requestId.
      handles.fireExtensionMessage({
        type: "send_chat_result",
        requestId: firstReq.requestId,
        ok: true,
      });
    }
    // The HTTP callback's promise should now resolve without throwing.
    await sendPromise;
  });

  test("a failed send_chat_result rejects the HTTP callback's promise", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const cbs = handles.httpCallbacks();
    const before = handles.outboundMessages().length;
    const sendPromise = Promise.resolve(cbs!.onSendChat("will fail"));
    await new Promise((r) => setTimeout(r, 5));

    const fresh = handles.outboundMessages().slice(before);
    expect(fresh).toHaveLength(1);
    const first = fresh[0];
    if (first && first.type === "send_chat") {
      handles.fireExtensionMessage({
        type: "send_chat_result",
        requestId: first.requestId,
        ok: false,
        error: "chat panel closed",
      });
    }

    let caught: Error | null = null;
    try {
      await sendPromise;
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("chat panel closed");
  });

  test("concurrent send_chat requests correlate independently by requestId", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const cbs = handles.httpCallbacks();
    const before = handles.outboundMessages().length;

    const firstPromise = Promise.resolve(cbs!.onSendChat("one"));
    const secondPromise = Promise.resolve(cbs!.onSendChat("two"));
    await new Promise((r) => setTimeout(r, 5));

    const fresh = handles.outboundMessages().slice(before);
    expect(fresh).toHaveLength(2);
    const first = fresh[0];
    const second = fresh[1];
    if (
      first?.type === "send_chat" &&
      second?.type === "send_chat" &&
      first.requestId !== second.requestId
    ) {
      // Reply to the second one first — should only resolve the second.
      handles.fireExtensionMessage({
        type: "send_chat_result",
        requestId: second.requestId,
        ok: true,
      });
      await secondPromise;
      // First still pending — resolve now.
      handles.fireExtensionMessage({
        type: "send_chat_result",
        requestId: first.requestId,
        ok: true,
      });
      await firstPromise;
    } else {
      throw new Error("expected two distinct send_chat requests");
    }
  });
});

describe("runBot — shutdown", () => {
  test("onLeave triggers the full shutdown path in the right order", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const cbs = handles.httpCallbacks();
    expect(cbs).not.toBeNull();

    await new Promise<void>((resolve) => {
      void (async () => {
        try {
          await cbs!.onLeave("user requested");
        } catch {
          // swallow
        }
        resolve();
      })();
    });

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(handles.exitCode()).toBe(0);

    const order = kinds(handles.calls);
    const startIdx = order.lastIndexOf("http.start") + 1;
    const shutdownOrder = order.slice(startIdx);

    // http.stop → leave command to extension → chrome.stop → audio.stop
    // → xvfb.stop → socket.stop → daemon.stop.
    const httpStop = shutdownOrder.indexOf("http.stop");
    expect(httpStop).toBeGreaterThanOrEqual(0);

    // A leave send message appears between http.stop and chrome.stop.
    const leaveSendIdx = shutdownOrder.findIndex((k) => k === "socket.send");
    expect(leaveSendIdx).toBeGreaterThan(httpStop);

    const chromeStop = shutdownOrder.indexOf("chrome.stop");
    expect(chromeStop).toBeGreaterThan(leaveSendIdx);
    const audioStop = shutdownOrder.indexOf("audio.stop");
    expect(audioStop).toBeGreaterThan(chromeStop);
    const xvfbStop = shutdownOrder.indexOf("xvfb.stop");
    expect(xvfbStop).toBeGreaterThan(audioStop);
    const socketStop = shutdownOrder.indexOf("socket.stop");
    expect(socketStop).toBeGreaterThan(xvfbStop);
    const daemonStop = shutdownOrder.indexOf("daemon.stop");
    expect(daemonStop).toBeGreaterThan(socketStop);

    // lifecycle:left published before daemon stop.
    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => e.state);
    expect(lifecycleStates[lifecycleStates.length - 1]).toBe("left");

    // Shutdown counts: each subsystem stopped exactly once.
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.chrome).toBe(1);
    expect(counts.audio).toBe(1);
    expect(counts.xvfb).toBe(1);
    expect(counts.socketServer).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
  });

  test("SIGTERM triggers the same shutdown path", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    handles.fireSigterm();

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(handles.exitCode()).toBe(0);
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.chrome).toBe(1);
    expect(counts.audio).toBe(1);
    expect(counts.xvfb).toBe(1);
    expect(counts.socketServer).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
  });

  test("SIGTERM + /leave do not double-stop subsystems", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    handles.fireSigterm();
    const cbs = handles.httpCallbacks();
    try {
      await cbs!.onLeave("redundant");
    } catch {
      // swallow
    }

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.chrome).toBe(1);
    expect(counts.audio).toBe(1);
    expect(counts.xvfb).toBe(1);
    expect(counts.socketServer).toBe(1);
  });
});

describe("runBot — error paths", () => {
  test("extension ready timeout shuts down with lifecycle:error", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      extensionReadyError: new Error(
        "timed out after 1000ms waiting for extension ready handshake",
      ),
    });

    await runBot(deps);

    expect(handles.exitCode()).toBe(1);
    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const err = lifecycleStates.find((s) => s.state === "error");
    expect(err).toBeDefined();
    expect(err?.detail).toContain("extension never signaled ready");

    // Audio + HTTP never started.
    const order = kinds(handles.calls);
    expect(order).not.toContain("audio.start");
    expect(order).not.toContain("http.start");
  });

  test("Chrome exiting unexpectedly mid-meeting shuts down with error state", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    // Simulate Chrome crashing outside of our control.
    handles.fireChromeExit(42);

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(handles.exitCode()).toBe(1);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const last = lifecycleStates[lifecycleStates.length - 1];
    expect(last?.state).toBe("error");
    expect(last?.detail).toContain("chrome exited unexpectedly");
    expect(last?.detail).toContain("42");
  });

  test("PulseAudio failure exits 1 without touching xvfb or chrome", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({
      pulseError: new Error("pulseaudio: connection refused"),
    });
    const realEnv = deps.env;
    deps.env = () => ({ ...realEnv(), skipPulse: false });

    await runBot(deps);

    expect(handles.exitCode()).toBe(1);
    const order = kinds(handles.calls);
    expect(order).toContain("pulse.setup");
    expect(order).not.toContain("xvfb.start");
    expect(order).not.toContain("chrome.launch");
    expect(
      handles.errors.some((e) => e.includes("PulseAudio setup failed")),
    ).toBe(true);
  });
});

describe("runBot — daemon-client terminal errors", () => {
  test("logs a single terminal error without shutting down", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const stopsBefore = handles.stopCounts();
    handles.fireDaemonError(new Error("ingress returned status 503"));
    await new Promise((r) => setTimeout(r, 20));

    const stopsAfter = handles.stopCounts();
    expect(stopsAfter.httpServer).toBe(stopsBefore.httpServer);
    expect(stopsAfter.chrome).toBe(stopsBefore.chrome);
    expect(stopsAfter.audio).toBe(stopsBefore.audio);
    expect(handles.daemonStopped()).toBe(false);

    expect(
      handles.errors.some((e) => e.includes("daemon ingress failure")),
    ).toBe(true);
  });

  test("second terminal error within the window triggers graceful shutdown", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    handles.fireDaemonError(
      new Error("ingress rejected batch with status 400"),
    );
    handles.fireDaemonError(new Error("ingress returned status 503"));

    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(handles.exitCode()).toBe(1);
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.chrome).toBe(1);
    expect(counts.audio).toBe(1);
    expect(handles.daemonStopped()).toBe(true);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const last = lifecycleStates[lifecycleStates.length - 1]!;
    expect(last.state).toBe("error");
    expect(last.detail).toContain("daemon ingress failure");
  });
});

/** -----------------------------------------------------------------------
 * Gap A: meetingId rewrite at the bot boundary
 * -----------------------------------------------------------------------
 * The Chrome extension stamps every event with `meetingId = location.pathname`
 * (the Meet URL code, e.g. `abc-defg-hij`), but the daemon keys each bot
 * session by the UUID passed via the `MEETING_ID` env. The bot must overwrite
 * `meetingId` with the authoritative UUID before forwarding to the daemon so
 * events correlate to the right session even if the extension misreports.
 */
describe("runBot — Gap A: meetingId rewrite at bot boundary", () => {
  test("participant.change has meetingId rewritten to the env UUID", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    // Simulate the extension's URL-code-based meetingId — not the env UUID.
    handles.fireExtensionMessage({
      type: "participant.change",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      joined: [{ id: "p-1", name: "Alice" }],
      left: [],
    });

    const fresh = handles.daemonEvents.slice(before);
    expect(fresh).toHaveLength(1);
    const event = fresh[0];
    expect(event?.type).toBe("participant.change");
    // Must be rewritten to the env UUID ("m-1" in test deps), not the
    // extension-supplied URL code.
    if (event?.type === "participant.change") {
      expect(event.meetingId).toBe("m-1");
    }
  });

  test("speaker.change + chat.inbound both have meetingId rewritten", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "speaker.change",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      speakerId: "p-1",
      speakerName: "Alice",
    });
    handles.fireExtensionMessage({
      type: "chat.inbound",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      fromId: "p-2",
      fromName: "Bob",
      text: "hello",
    });

    const fresh = handles.daemonEvents.slice(before);
    expect(fresh).toHaveLength(2);
    for (const event of fresh) {
      if (event.type === "speaker.change" || event.type === "chat.inbound") {
        expect(event.meetingId).toBe("m-1");
      }
    }
  });

  test("lifecycle events have meetingId rewritten to the env UUID", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    await bootHappyPath(deps, handles);

    const before = handles.daemonEvents.length;
    handles.fireExtensionMessage({
      type: "lifecycle",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      state: "joined",
    });

    const fresh = handles.daemonEvents.slice(before);
    expect(fresh).toHaveLength(1);
    const event = fresh[0];
    expect(event?.type).toBe("lifecycle");
    if (event?.type === "lifecycle") {
      expect(event.meetingId).toBe("m-1");
      expect(event.state).toBe("joined");
    }
  });
});

/** -----------------------------------------------------------------------
 * Gap B: extension-joined deadline
 * -----------------------------------------------------------------------
 * `waitForReady` only proves the extension is alive, not that Chrome landed
 * on a Meet tab. A restore-session dialog or redirect loop leaves the
 * content script unmounted and the `join` relay is silently dropped. Bound
 * the wait with `extensionJoinedTimeoutMs` so the bot doesn't sit in
 * `phase=joining` forever.
 */
describe("runBot — Gap B: extension-joined deadline", () => {
  test("fires shutdown with error when extension never reaches joined", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({ extensionJoinedTimeoutMs: 50 });
    const running = runBot(deps);
    // Let the boot reach `waitForReady`, then fire ready but never fire
    // `lifecycle:joined`. The timer should trip and shutdown should fire.
    await new Promise((r) => setTimeout(r, 5));
    handles.fireExtensionReady();
    await running;

    // Wait longer than `extensionJoinedTimeoutMs` for the timer to fire.
    const deadline = Date.now() + 1_000;
    while (handles.exitCode() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(handles.exitCode()).toBe(1);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const errState = lifecycleStates.find((s) => s.state === "error");
    expect(errState).toBeDefined();
    expect(errState?.detail).toContain(
      "extension did not reach joined state within 50ms",
    );

    // Full shutdown should have run.
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(1);
    expect(counts.chrome).toBe(1);
    expect(counts.audio).toBe(1);
    expect(counts.xvfb).toBe(1);
    expect(counts.socketServer).toBe(1);
    expect(handles.daemonStopped()).toBe(true);
  });

  test("lifecycle:joined from extension clears the timer (no shutdown)", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({ extensionJoinedTimeoutMs: 50 });
    const running = runBot(deps);
    await new Promise((r) => setTimeout(r, 5));
    handles.fireExtensionReady();
    await running;

    // Fire `joined` before the timer deadline — should prevent shutdown.
    handles.fireExtensionMessage({
      type: "lifecycle",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      state: "joined",
    });

    // Give the timer plenty of time to fire if it wasn't cleared.
    await new Promise((r) => setTimeout(r, 100));

    // No shutdown should have occurred.
    expect(handles.exitCode()).toBeNull();
    const counts = handles.stopCounts();
    expect(counts.httpServer).toBe(0);
    expect(counts.chrome).toBe(0);
    expect(counts.audio).toBe(0);
    expect(handles.daemonStopped()).toBe(false);
  });

  test("lifecycle:error from extension clears the timer (no duplicate shutdown)", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps({ extensionJoinedTimeoutMs: 50 });
    const running = runBot(deps);
    await new Promise((r) => setTimeout(r, 5));
    handles.fireExtensionReady();
    await running;

    // Fire `error` — handler updates state and clears the timer, but does
    // not itself initiate shutdown (that's the extension's signal the
    // meet-side died; shutdown is a separate path we're validating is
    // idempotent).
    handles.fireExtensionMessage({
      type: "lifecycle",
      meetingId: "abc-defg-hij",
      timestamp: new Date().toISOString(),
      state: "error",
      detail: "prejoin captcha",
    });

    // Give the timer plenty of time to fire if it wasn't cleared.
    await new Promise((r) => setTimeout(r, 100));

    // The error lifecycle event was forwarded.
    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => e.state);
    expect(lifecycleStates).toContain("error");

    // But no timer-driven shutdown should have fired.
    // exitCode remains null because nothing else triggered shutdown.
    expect(handles.exitCode()).toBeNull();
  });
});

/** -----------------------------------------------------------------------
 * Gap C: error detail forwarded to the daemon
 * -----------------------------------------------------------------------
 * Previously `waitForReady` / send-join failures reported a generic string
 * to the daemon, losing the underlying error's message. The specific cause
 * must reach the conversation log.
 */
describe("runBot — Gap C: error detail forwarding", () => {
  test("waitForReady rejection forwards the underlying error message to daemon", async () => {
    BotState.__resetForTests();
    const specific =
      "timed out after 1234ms waiting for extension ready handshake";
    const { deps, handles } = makeDeps({
      extensionReadyError: new Error(specific),
    });

    await runBot(deps);

    expect(handles.exitCode()).toBe(1);

    const lifecycleStates = handles.daemonEvents
      .filter((e): e is LifecycleEvent => e.type === "lifecycle")
      .map((e) => ({ state: e.state, detail: e.detail }));
    const errState = lifecycleStates.find((s) => s.state === "error");
    expect(errState).toBeDefined();
    // Detail must contain BOTH the generic context AND the specific cause.
    expect(errState?.detail).toContain("extension never signaled ready");
    expect(errState?.detail).toContain(specific);
  });
});

/** -----------------------------------------------------------------------
 * avatarDevicePath threading to launchChrome
 * -----------------------------------------------------------------------
 * When `services.meet.avatar.devicePath` is set (threaded down as
 * `AVATAR_DEVICE_PATH` on the bot env), the bot must pass the same
 * device path to `launchChrome` so Chrome's
 * `--use-file-for-fake-video-capture=<path>` flag targets the device
 * the renderer writes to. Without this, the renderer writes frames to
 * one node (e.g. `/dev/video11`) and Chrome reads from another
 * (`/dev/video10` default) and participants see a black frame.
 */
describe("runBot — avatarDevicePath threads to launchChrome", () => {
  test("env.avatarDevicePath flows through to launchChrome when set", async () => {
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    const realEnv = deps.env;
    deps.env = () => ({
      ...realEnv(),
      avatarEnabled: true,
      avatarDevicePath: "/dev/video11",
    });

    await bootHappyPath(deps, handles);

    const launchCall = handles.calls.find((c) => c.kind === "chrome.launch");
    expect(launchCall).toBeDefined();
    expect(launchCall!.avatarEnabled).toBe(true);
    expect(launchCall!.avatarDevicePath).toBe("/dev/video11");
  });

  test("omits avatarDevicePath from launchChrome when env is unset", async () => {
    // When no operator override exists, the key is absent from the
    // options object so the launcher falls back to its module-local
    // DEFAULT_AVATAR_DEVICE_PATH. This is important: a spurious
    // `avatarDevicePath: undefined` would also work, but absence is
    // the cleanest signal "use the default".
    BotState.__resetForTests();
    const { deps, handles } = makeDeps();
    const realEnv = deps.env;
    deps.env = () => ({
      ...realEnv(),
      avatarEnabled: true,
      avatarDevicePath: undefined,
    });

    await bootHappyPath(deps, handles);

    const launchCall = handles.calls.find((c) => c.kind === "chrome.launch");
    expect(launchCall).toBeDefined();
    expect(launchCall!.avatarEnabled).toBe(true);
    expect(launchCall!.avatarDevicePath).toBeUndefined();
  });
});
