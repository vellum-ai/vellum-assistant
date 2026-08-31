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

import { createInterface, type Interface } from "node:readline";

import chalk from "chalk";

import { extractValueFlag } from "../lib/arg-utils.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { CliLiveVoiceClient } from "../lib/live-voice/client.js";
import {
  LiveVoiceConnectionError,
  resolveLiveVoiceConnection,
} from "../lib/live-voice/connection.js";
import { PcmPlayer } from "../lib/live-voice/pcm-player.js";
import { MAX_TEXT_TURN_CHARS } from "../lib/live-voice/protocol.js";

function printUsage(): void {
  console.log(`vellum voice - Talk to an assistant by typing; hear it answer

USAGE:
    vellum voice [assistant] [options]

ARGUMENTS:
    [assistant]    Instance name or ID (default: active assistant)

OPTIONS:
    --conversation <id>  Continue an existing conversation instead of starting one
    --say <message>      Take this one turn, speak the reply, then exit. For
                         scripts and triggers: no prompt, no terminal needed.
    --no-audio           Print replies without speaking them
    --help               Show this help

DESCRIPTION:
    Opens a live-voice session with no microphone. Each line you type is
    taken as a turn and the reply is streamed back as text and spoken aloud.
    A turn is at most ${MAX_TEXT_TURN_CHARS} characters.

    Speech needs a PCM player on PATH. ffplay, play (sox), or aplay stream the
    audio as it arrives; afplay (macOS) plays each reply once it is complete.
    With none of them installed the session still runs, printed but silent.

    Ctrl+C interrupts the assistant mid-reply. Ctrl+D, or Ctrl+C when nothing
    is being spoken, ends the session.

    Works with local, self-hosted, and Vellum cloud assistants. A cloud
    assistant needs a platform login ('vellum login'); the session is
    authorized per-connection from it.

EXAMPLES:
    vellum voice
    vellum voice my-assistant --say "i just got back to my desk"
    vellum voice my-assistant
    vellum voice my-assistant --no-audio
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
  // One turn, then exit. Extracted before the assistant target is parsed so a
  // multi-word message is never mistaken for a display name.
  const sayText = extractValueFlag(args, "say");
  const assistantArg = parseAssistantTargetArg(args);
  const audioEnabled = !args.includes("--no-audio");

  if (sayText !== undefined && sayText.trim().length === 0) {
    console.error("Error: --say needs a message.");
    process.exit(1);
  }
  if (sayText !== undefined && sayText.length > MAX_TEXT_TURN_CHARS) {
    console.error(
      `Error: --say is ${sayText.length} characters, limit is ${MAX_TEXT_TURN_CHARS}.`,
    );
    process.exit(1);
  }

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
  const client = new CliLiveVoiceClient({
    url: connection.url,
    token: connection.token,
    tokenTransport: connection.tokenTransport,
    ...(conversationId ? { conversationId } : {}),
  });

  await runSession({
    client,
    player,
    reference: connection.reference,
    ...(sayText !== undefined ? { sayText } : {}),
  });
}

/** Exported for tests. Not part of the command's public surface. */
export interface SessionDeps {
  client: CliLiveVoiceClient;
  player: PcmPlayer | null;
  reference: string;
  /**
   * Take this one turn and exit, instead of opening a prompt.
   *
   * The session ends only once the reply has finished *speaking*, which is why
   * this cannot be approximated by piping a line into the interactive prompt:
   * stdin reaches EOF the instant the line is read, readline closes, and the
   * session is torn down while the turn is still in flight. That race is
   * winnable on a fast local assistant and reliably lost over velay.
   */
  sayText?: string;
}

/**
 * Drive one session to completion.
 *
 * Resolves when the socket closes, whether that is the user leaving or a
 * failure. The exit code is set on the way out rather than thrown, so a failed
 * session prints one line instead of a stack.
 */
export function runSession({
  client,
  player,
  reference,
  sayText,
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

    const finish = (error?: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      player?.dispose();
      rl?.close();
      if (error) {
        console.error(`\n${chalk.red("Error:")} ${error}`);
        process.exitCode = 1;
      }
      resolve();
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
      if (note) {
        process.stdout.write(chalk.dim(note));
      }
      process.stdout.write("\n");
      if (sayText !== undefined) {
        // The reply has been spoken to the end (`turnDone` waits on the
        // player before calling this), so there is nothing left to stay open
        // for. Ending here also frees the assistant's single live-voice slot
        // rather than holding it for a timeout to reclaim.
        client.end();
        return;
      }
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
      if (sayText !== undefined) {
        if (!client.supportsTextInput) {
          finish(
            `${reference} does not accept typed turns. Upgrade it with ` +
              `'vellum upgrade' and try again.`,
          );
          client.end();
          return;
        }
        console.log(
          chalk.dim(`Connected to ${reference}. ${describePlayback(player)}.`),
        );
        console.log(`Conversation: ${chalk.dim(frame.conversationId)}\n`);
        if (!client.sendText(sayText)) {
          finish("Message not sent, the session is closed.");
          client.end();
          return;
        }
        turnInFlight = true;
        activeTurnId = null;
        return;
      }

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

      console.log(
        chalk.dim(`Connected to ${reference}. ${describePlayback(player)}.`),
      );
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
          "Type a message and press enter. Ctrl+C interrupts, Ctrl+D exits.",
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
      //
      // `player` is null under `--no-audio`, and optional chaining on its own
      // would short-circuit the whole expression in that case, skipping
      // `.then()` and leaving `endTurn()` uncalled. `?? Promise.resolve()`
      // keeps a promise on the left of `.then` either way, so the turn always
      // ends whether or not there is a player to wait on.
      void (player?.finish() ?? Promise.resolve()).then(() => endTurn());
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
