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

import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { CliLiveVoiceClient } from "../lib/live-voice/client.js";
import {
  LiveVoiceConnectionError,
  resolveLiveVoiceConnection,
} from "../lib/live-voice/connection.js";
import { PcmPlayer } from "../lib/live-voice/pcm-player.js";
import { MAX_TEXT_TURN_CHARS } from "../lib/live-voice/protocol.js";

const VALUE_FLAGS = ["--conversation"] as const;

function printUsage(): void {
  console.log(`vellum voice - Talk to an assistant by typing; hear it answer

USAGE:
    vellum voice [assistant] [options]

ARGUMENTS:
    [assistant]    Instance name or ID (default: active assistant)

OPTIONS:
    --conversation <id>  Continue an existing conversation instead of starting one
    --no-audio           Print replies without speaking them
    --help               Show this help

DESCRIPTION:
    Opens a live-voice session with no microphone. Each line you type is taken
    as a turn (max ${MAX_TEXT_TURN_CHARS} characters) and the reply is streamed
    back as text and spoken aloud.

    Speech needs a PCM player on PATH: ffplay, play (sox), or aplay stream the
    audio as it arrives; afplay (macOS) plays each reply once it is complete.
    With none of them installed the session still runs, printed but silent.

    Ctrl+C interrupts the assistant mid-reply. Ctrl+D, or Ctrl+C when nothing
    is being spoken, ends the session.

    Local and self-hosted assistants only. Vellum cloud assistants authenticate
    with a session token, which the voice endpoint does not accept.

EXAMPLES:
    vellum voice
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

  const assistantArg = parseAssistantTargetArg(args, VALUE_FLAGS);
  const conversationIdx = args.indexOf("--conversation");
  const conversationId =
    conversationIdx !== -1 ? args[conversationIdx + 1] : undefined;
  if (conversationIdx !== -1 && !conversationId) {
    console.error("Error: --conversation requires a conversation id.");
    process.exit(1);
  }
  const audioEnabled = !args.includes("--no-audio");

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
    ...(conversationId ? { conversationId } : {}),
  });

  await runSession({ client, player, reference: connection.reference });
}

interface SessionDeps {
  client: CliLiveVoiceClient;
  player: PcmPlayer | null;
  reference: string;
}

/**
 * Drive one session to completion.
 *
 * Resolves when the socket closes, whether that is the user leaving or a
 * failure; the exit code is set on the way out rather than thrown, so a failed
 * session prints one line instead of a stack.
 */
function runSession({ client, player, reference }: SessionDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    let rl: Interface | null = null;
    // True from the moment a turn is sent until its speech is done or
    // cancelled. The daemon refuses a second turn while one is in flight, so
    // the prompt is withheld for exactly as long.
    let turnInFlight = false;
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

    const endTurn = (): void => {
      turnInFlight = false;
      replyStarted = false;
      lastActivity = "";
      process.stdout.write("\n");
      rl?.prompt();
    };

    client.on("ready", (frame) => {
      const speaking = describePlayback(player);

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

      console.log(chalk.dim(`Connected to ${reference} — ${speaking}.`));
      if (!client.hasAudioInput) {
        // Expected here rather than alarming: this client declared it can type,
        // which is what let the session open text-only instead of being refused.
        console.log(
          chalk.dim(
            "Speech-to-text is not configured on this assistant; typed turns only.",
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
        prompt: chalk.cyan("› "),
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
          console.error(chalk.yellow("Still replying — Ctrl+C to interrupt."));
          return;
        }
        if (!client.sendText(text)) {
          console.error(
            chalk.yellow("Message not sent — the session is closed."),
          );
          return;
        }
        turnInFlight = true;
        // Withhold the prompt until the reply lands, so the next line the user
        // types is not composed against a turn the daemon would refuse.
        rl?.pause();
      });

      rl.on("SIGINT", () => {
        if (turnInFlight) {
          // Barge-in: the same thing speaking over the assistant does.
          client.interrupt();
          player?.stop();
          return;
        }
        client.end();
      });

      rl.on("close", () => {
        // Ctrl+D at the prompt. `end()` is idempotent, so this is also the
        // path taken when finish() closed the interface itself.
        client.end();
      });

      rl.prompt();
    });

    client.on("activity", (frame) => {
      // Only worth showing while the turn is still silent — once text is
      // streaming, the reply itself is the better progress indicator.
      if (replyStarted || frame.label === "" || frame.label === lastActivity) {
        return;
      }
      lastActivity = frame.label;
      console.log(chalk.dim(`  … ${frame.label}`));
    });

    client.on("textDelta", (frame) => {
      if (!replyStarted) {
        replyStarted = true;
        process.stdout.write(chalk.green("‹ "));
      }
      process.stdout.write(frame.text);
    });

    client.on("audio", (frame) => {
      if (!player) {
        return;
      }
      player.write(Buffer.from(frame.dataBase64, "base64"), frame.sampleRate);
    });

    client.on("turnDone", () => {
      player?.finish();
      if (turnInFlight) {
        rl?.resume();
        endTurn();
      }
    });

    client.on("turnCancelled", () => {
      // Audio still in flight belongs to a turn that no longer exists.
      player?.stop();
      if (turnInFlight) {
        process.stdout.write(chalk.dim(" [interrupted]"));
        rl?.resume();
        endTurn();
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
      if (turnInFlight) {
        rl?.resume();
        endTurn();
      }
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
    return "audio off (--no-audio)";
  }
  switch (player.mode) {
    case "streaming":
      return `speaking via ${player.playerName}`;
    case "buffered":
      return `speaking via ${player.playerName}, one reply at a time`;
    case "silent":
      return "silent — install ffplay, sox, or aplay to hear replies";
  }
}
