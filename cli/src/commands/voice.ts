/**
 * `vellum voice [assistant]`
 *
 * Type a turn in the terminal, hear the assistant speak the reply.
 *
 * A real live-voice session that never opens a microphone: each typed line
 * goes out as a `text` frame and joins the pipeline where a finished
 * transcript would have, so the answer streams back through the same turn
 * runner, the same segmented text-to-speech, and the same barge-in as a spoken
 * turn. Ctrl+C mid-reply cuts the assistant off exactly as speaking over it
 * would.
 */

import {
  clearLine,
  createInterface,
  cursorTo,
  type Interface,
} from "node:readline";

import chalk from "chalk";

import { extractValueFlag } from "../lib/arg-utils.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { CliLiveVoiceClient } from "../lib/live-voice/client.js";
import {
  LiveVoiceConnectionError,
  resolveLiveVoiceConnection,
} from "../lib/live-voice/connection.js";
import { PcmPlayer } from "../lib/live-voice/pcm-player.js";
import {
  PcmRecorder,
  recorderInstallHint,
} from "../lib/live-voice/pcm-recorder.js";
import { MAX_TEXT_TURN_CHARS } from "../lib/live-voice/protocol.js";

function printUsage(): void {
  console.log(`vellum voice - Talk to an assistant by typing; hear it answer

USAGE:
    vellum voice [assistant] [options]

ARGUMENTS:
    [assistant]    Instance name or ID (default: active assistant)

OPTIONS:
    --conversation <id>  Continue an existing conversation instead of starting one
    --no-audio           Print replies without speaking them
    --no-mic             Take turns by typing only, even if a recorder is present
    --help               Show this help

DESCRIPTION:
    Opens a live-voice session. Speak a turn, or type one, and the reply is
    streamed back as text and spoken aloud. A typed turn is at most
    ${MAX_TEXT_TURN_CHARS} characters.

    Both halves need a PCM tool on PATH, and each degrades on its own:

      Speaking   ffplay, play (sox), or aplay stream audio as it arrives;
                 afplay (macOS) plays each reply once complete. With none
                 of them the session runs printed but silent.
      Listening  arecord (alsa-utils), sox, or ffmpeg. With none of them,
                 or with --no-mic, turns are typed.

    Ctrl+C interrupts the assistant mid-reply. Ctrl+D, or Ctrl+C when nothing
    is being spoken, ends the session.

    Local and self-hosted assistants only. Vellum cloud assistants authenticate
    with a session token, which the voice endpoint does not accept.

EXAMPLES:
    vellum voice
    vellum voice my-assistant
    vellum voice my-assistant --no-audio
    vellum voice my-assistant --no-mic
    vellum voice --conversation conv_01H8XK3
`);
}

export async function voice(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  // Strips `--conversation <id>` from argv, rejecting a `-`-prefixed value:
  // the daemon accepts any non-empty conversation id, so a swallowed option
  // would open a conversation named after the flag it ate.
  const conversationId = extractValueFlag(args, "conversation");
  const assistantArg = parseAssistantTargetArg(args);
  const audioEnabled = !args.includes("--no-audio");
  const micEnabled = !args.includes("--no-mic");

  let connection;
  try {
    connection = await resolveLiveVoiceConnection(assistantArg);
  } catch (err) {
    if (err instanceof LiveVoiceConnectionError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const player = audioEnabled ? new PcmPlayer() : null;
  const recorder = micEnabled ? new PcmRecorder() : null;
  const listening = recorder?.recorderName != null;
  const client = new CliLiveVoiceClient({
    url: connection.url,
    token: connection.token,
    // Only ask the daemon to find turn boundaries when there is a microphone
    // to find them in. A `server_vad` session fed no audio waits forever for
    // an utterance that never starts.
    ...(listening ? { turnDetection: "server_vad" as const } : {}),
    ...(conversationId ? { conversationId } : {}),
  });

  await runSession({
    client,
    player,
    recorder: listening ? recorder : null,
    micRequested: micEnabled,
    reference: connection.reference,
  });
}

interface SessionDeps {
  client: CliLiveVoiceClient;
  player: PcmPlayer | null;
  recorder: PcmRecorder | null;
  /** Whether a microphone was wanted, which `--no-mic` is the way to say no to. */
  micRequested: boolean;
  reference: string;
}

/**
 * Drive one session to completion.
 *
 * Resolves when the socket closes, whether that is the user leaving or a
 * failure. The exit code is set on the way out rather than thrown, so a failed
 * session prints one line instead of a stack.
 */
function runSession({
  client,
  player,
  recorder,
  micRequested,
  reference,
}: SessionDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    let rl: Interface | null = null;
    // True from the moment a turn is sent until its reply has been spoken.
    // The daemon refuses a second turn while one is in flight, so the prompt
    // is withheld for exactly as long.
    let turnInFlight = false;
    /**
     * The in-flight turn's server-side id, once a frame has named it.
     *
     * Matches a completion frame to the turn it belongs to, so one that
     * arrives late cannot end a turn it does not describe. Null while the turn
     * is still anonymous, in which case a completion frame is taken at face
     * value: there is nothing to contradict it.
     */
    let activeTurnId: string | null = null;
    // Whether anything of this turn's reply has been printed yet, so the
    // speaker label is written once rather than per delta.
    let replyStarted = false;
    let lastActivity = "";
    let finished = false;
    /** Settled transcript spans for the utterance being spoken. */
    let spokenFinals: string[] = [];
    /** The interim tail after those spans. Replaced, never appended. */
    let spokenPartial = "";
    /** True while a transcript line is drawn and awaiting its newline. */
    let transcriptOpen = false;

    const finish = (error?: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      recorder?.stop();
      player?.dispose();
      rl?.close();
      if (error) {
        console.error(`\n${chalk.red("Error:")} ${error}`);
        process.exitCode = 1;
      }
      resolve();
    };

    /**
     * Draw the utterance in progress over the prompt line.
     *
     * Rewritten in place rather than appended, because a partial is a running
     * replacement for the tail of the same sentence; printing each one would
     * scroll a paragraph of near-duplicates past the user as they talk. A
     * non-TTY has no cursor to move, so there it stays quiet until the
     * transcript settles.
     */
    const drawTranscript = (): void => {
      if (!process.stdout.isTTY) {
        return;
      }
      const spoken = [...spokenFinals, spokenPartial]
        .filter((part) => part.length > 0)
        .join(" ");
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
      process.stdout.write(chalk.cyan("> ") + chalk.dim(spoken));
      transcriptOpen = true;
    };

    /** Settle the transcript line, or erase it if nothing was said. */
    const closeTranscript = (): void => {
      const spoken = spokenFinals.join(" ").trim();
      spokenFinals = [];
      spokenPartial = "";
      if (!transcriptOpen) {
        return;
      }
      transcriptOpen = false;
      if (process.stdout.isTTY) {
        cursorTo(process.stdout, 0);
        clearLine(process.stdout, 0);
      }
      if (spoken.length > 0) {
        process.stdout.write(`${chalk.cyan("> ")}${spoken}\n`);
      }
    };

    /** Hand the prompt back and let the user take another turn. */
    const endTurn = (note?: string): void => {
      // `finished` matters as much as `turnInFlight`: a session that closed
      // while a `finish()` was still awaited resolves it through dispose(),
      // and the prompt must not be redrawn under a closed interface.
      if (!turnInFlight || finished) {
        return;
      }
      turnInFlight = false;
      activeTurnId = null;
      replyStarted = false;
      lastActivity = "";
      spokenFinals = [];
      spokenPartial = "";
      transcriptOpen = false;
      if (note) {
        process.stdout.write(chalk.dim(note));
      }
      process.stdout.write("\n");
      rl?.resume();
      rl?.prompt();
    };

    /**
     * Whether a completion frame belongs to the turn currently in flight.
     *
     * A turn abandoned locally (Ctrl+C) leaves the prompt free while the
     * daemon may still be winding down, so a late frame must not be allowed to
     * end whatever turn came after it.
     */
    const completesActiveTurn = (turnId: string): boolean =>
      turnInFlight && (activeTurnId === null || activeTurnId === turnId);

    client.on("ready", (frame) => {
      if (!client.supportsTextInput) {
        // The `ready` echo is the only reliable signal. A daemon that predates
        // typed turns answers every `text` frame with `unknown_type`, so
        // opening the prompt anyway would give the user a session that
        // silently swallows everything they type.
        finish(
          `${reference} does not accept typed turns. Upgrade it with ` +
            `'vellum upgrade' and try again.`,
        );
        client.end();
        return;
      }

      // A daemon that ignored `server_vad` runs a manual session, and a manual
      // session has no way to close a spoken turn: this client sends no
      // `ptt_release`, so audio would stream into a turn that never ends.
      // Better to say so and type than to hold an open microphone that does
      // nothing.
      const vadHonoured =
        recorder === null || client.turnDetection === "server_vad";
      const micUsable =
        recorder !== null && client.hasAudioInput && vadHonoured;

      console.log(
        chalk.dim(
          `Connected to ${reference}. ${describePlayback(player)}. ` +
            `${describeCapture(recorder, micRequested, micUsable)}.`,
        ),
      );
      if (recorder !== null && client.hasAudioInput && !vadHonoured) {
        console.log(
          chalk.yellow(
            "This assistant did not accept hands-free turn detection, so the " +
              "microphone stays closed. Typed turns still work.",
          ),
        );
      }
      if (!client.hasAudioInput) {
        // Expected here rather than alarming: this client declared it can type,
        // which is what let the session open text-only instead of being refused.
        console.log(
          chalk.dim(
            "Speech-to-text is not configured on this assistant, so typed turns only.",
          ),
        );
      }
      console.log(
        chalk.dim(
          micUsable
            ? "Just talk, or type a message and press enter. Ctrl+C interrupts, Ctrl+D exits."
            : "Type a message and press enter. Ctrl+C interrupts, Ctrl+D exits.",
        ),
      );
      console.log(`Conversation: ${chalk.dim(frame.conversationId)}\n`);

      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan("> "),
      });

      rl.on("line", (line) => {
        const text = line.trim();
        if (text.length === 0) {
          rl?.prompt();
          return;
        }
        if (text.length > MAX_TEXT_TURN_CHARS) {
          console.error(
            chalk.yellow(
              `Too long: ${text.length} characters, limit is ${MAX_TEXT_TURN_CHARS}.`,
            ),
          );
          rl?.prompt();
          return;
        }
        if (turnInFlight) {
          console.error(chalk.yellow("Still replying. Ctrl+C to interrupt."));
          return;
        }
        if (!client.sendText(text)) {
          console.error(
            chalk.yellow("Message not sent, the session is closed."),
          );
          return;
        }
        turnInFlight = true;
        activeTurnId = null;
        // Withhold the prompt until the reply lands, so the next line the user
        // types is not composed against a turn the daemon would refuse.
        rl?.pause();
      });

      rl.on("SIGINT", () => {
        if (!turnInFlight) {
          client.end();
          return;
        }
        // Barge-in. The turn ends here rather than on a frame from the daemon,
        // because a client `interrupt` is answered with neither `tts_done` nor
        // `turn_cancelled`: the daemon's `interrupt()` cancels the turn through
        // `cancelAssistantTurn`, `tts_done` is gated on the turn not being
        // aborted, and `turn_cancelled` is only sent down the VAD barge-in
        // path. Waiting for one would hang the prompt for the rest of the
        // session.
        client.interrupt();
        player?.stop();
        endTurn(" [interrupted]");
      });

      rl.on("close", () => {
        // Ctrl+D at the prompt. `end()` is idempotent, so this is also the
        // path taken when finish() closed the interface itself.
        client.end();
      });

      rl.prompt();

      if (micUsable && recorder) {
        recorder.start(
          (pcm) => client.sendAudio(pcm),
          (reason) => {
            // A recorder that dies is not a session that dies. Say what
            // happened once and leave the user typing, which is exactly what
            // a machine with no recorder does from the start.
            console.error(
              chalk.yellow(
                `\nMicrophone stopped: ${reason}. Typed turns still work.`,
              ),
            );
            recorder.stop();
            if (!turnInFlight) {
              rl?.prompt();
            }
          },
        );
      }
    });

    client.on("speechStarted", () => {
      // Whatever is queued belongs to a reply being spoken over.
      player?.stop();
      if (!turnInFlight) {
        turnInFlight = true;
        activeTurnId = null;
        rl?.pause();
      }
      drawTranscript();
    });

    client.on("sttPartial", (frame) => {
      spokenPartial = frame.text;
      drawTranscript();
    });

    client.on("sttFinal", (frame) => {
      if (frame.text.trim().length > 0) {
        spokenFinals.push(frame.text.trim());
      }
      spokenPartial = "";
      drawTranscript();
    });

    client.on("utteranceEnd", () => {
      closeTranscript();
    });

    client.on("utteranceDiscarded", () => {
      // A cough, a door, a false trigger. Erase the line it drew and give the
      // prompt back rather than leaving a turn that will never produce a reply.
      spokenFinals = [];
      spokenPartial = "";
      closeTranscript();
      endTurn();
    });

    client.on("activity", (frame) => {
      activeTurnId = frame.turnId;
      // Only worth showing while the turn is still silent. Once text is
      // streaming, the reply itself is the better progress indicator.
      if (replyStarted || frame.label === "" || frame.label === lastActivity) {
        return;
      }
      lastActivity = frame.label;
      console.log(chalk.dim(`  ... ${frame.label}`));
    });

    client.on("textDelta", (frame) => {
      if (!replyStarted) {
        replyStarted = true;
        process.stdout.write(chalk.green("< "));
      }
      process.stdout.write(frame.text);
    });

    client.on("audio", (frame) => {
      if (!player) {
        return;
      }
      player.write(Buffer.from(frame.dataBase64, "base64"), frame.sampleRate);
    });

    client.on("turnDone", (turnId) => {
      if (!completesActiveTurn(turnId)) {
        // Still drain the audio: the frame is stale for the prompt's purposes
        // but the bytes are real and already queued.
        void player?.finish();
        return;
      }
      // The turn is not over until the speaker is quiet. Handing the prompt
      // back at the last byte instead would make Ctrl+C quit the session while
      // the assistant is still talking, and let the next turn start a second
      // player over the top of the first.
      void player?.finish().then(() => endTurn());
    });

    client.on("turnCancelled", (turnId) => {
      // Audio still in flight belongs to a turn that no longer exists.
      player?.stop();
      if (completesActiveTurn(turnId)) {
        endTurn(" [interrupted]");
      }
    });

    client.on("textTurnRejected", (reason, message) => {
      console.error(
        chalk.yellow(
          reason === "unsupported"
            ? `Typed turns are not supported by this assistant: ${message}`
            : `Turn not taken: ${message}`,
        ),
      );
      player?.stop();
      endTurn();
    });

    client.on("warning", (message) => {
      console.error(chalk.yellow(`Warning: ${message}`));
    });

    client.on("closed", (error) => {
      if (!error) {
        console.log(chalk.dim("\nSession ended."));
      }
      finish(error);
    });

    client.connect();
  });
}

/**
 * How this session will (or will not) speak, for the connection banner.
 *
 * The two silent cases are worth telling apart: a user who passed --no-audio
 * knows why it is quiet, and a user who did not needs to be told that
 * installing a player is what turns the sound on.
 */
function describePlayback(player: PcmPlayer | null): string {
  if (!player) {
    return "Audio off (--no-audio)";
  }
  switch (player.mode) {
    case "streaming":
      return `Speaking via ${player.playerName}`;
    case "buffered":
      return `Speaking via ${player.playerName}, one reply at a time`;
    case "silent":
      return "Silent: install ffplay, sox, or aplay to hear replies";
  }
}

/**
 * How this session will (or will not) listen, for the connection banner.
 *
 * Three outcomes worth telling apart: a live microphone, one deliberately
 * switched off, and a machine that has no recorder at all. Only the last is
 * something the user can fix, so only the last names what to install.
 */
function describeCapture(
  recorder: PcmRecorder | null,
  requested: boolean,
  usable: boolean,
): string {
  if (!requested) {
    return "Microphone off (--no-mic)";
  }
  if (recorder === null) {
    // The only one of these the user can act on, so the only one that says how.
    return `No recorder found, typing only (${recorderInstallHint()})`;
  }
  if (!usable) {
    return "Microphone unavailable";
  }
  return `Listening via ${recorder.recorderName}`;
}
