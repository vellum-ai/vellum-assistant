/** Declarative help for the `assistant tts` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const ttsHelp: CliCommandHelp = {
  name: "tts",
  description: "Text-to-speech operations",
  helpText: `
TTS commands use your configured TTS provider to synthesize text to audio.
The provider is set via:

  $ assistant config set services.tts.provider <provider>

Built-in providers: elevenlabs, fish-audio, deepgram, xai.

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence"
  $ echo "piped input" | assistant tts synthesize`,
  subcommands: [
    {
      name: "synthesize",
      description: "Synthesize text to audio using the configured TTS provider",
      arguments: [
        {
          name: "[text...]",
          description:
            "Text to synthesize (joined with spaces; alternative to --text or stdin)",
        },
      ],
      options: [
        {
          flags: "--text <text>",
          description:
            "Text to synthesize to audio (alternative: pass as positional arg or pipe via stdin)",
        },
        {
          flags: "--output <path>",
          description:
            "Path to write the audio file (defaults to system temp dir with auto-generated name)",
        },
        {
          flags: "--voice <id>",
          description:
            "Provider-specific voice identifier (ElevenLabs voiceId, Fish Audio referenceId, etc.) — overrides configured default",
        },
        {
          flags: "--use-case <case>",
          description:
            "Synthesis use case: 'message-playback' (default, higher quality) or 'phone-call' (lower latency)",
          defaultValue: "message-playback",
        },
        {
          flags: "--json",
          description: "Output structured JSON instead of plain file path",
        },
      ],
      helpText: `
Input modes (pick one):
  --text <text>         Text to synthesize to audio.
  [text...]             Positional argument(s) joined with spaces.
  stdin                 Piped input when neither --text nor a positional is given.

Options:
  --output <path>       Path to write the audio file. When omitted, a file is
                        written to the system temp directory with a random
                        name and the extension derived from the provider's
                        returned MIME type (mp3 for ElevenLabs, wav for
                        Deepgram/Fish Audio in WAV mode). Parent directories
                        are created as needed.
  --voice <id>          Provider-specific voice identifier that overrides the
                        configured default. Format depends on the provider
                        (e.g. an ElevenLabs voiceId or a Fish Audio referenceId).
  --use-case <case>     Synthesis use case — 'message-playback' (default,
                        higher quality) or 'phone-call' (lower latency).
  --json                Output a single-line JSON object on stdout instead of
                        the plain file path. Errors are also emitted as JSON.

Examples:
  $ assistant tts synthesize --text "hello world"
  $ assistant tts synthesize "spoken sentence" --output /tmp/out.mp3
  $ echo "hello" | assistant tts synthesize
  $ assistant tts synthesize --text "hi" --voice <voice-id>
  $ assistant tts synthesize --text "hi" --use-case phone-call
  $ assistant tts synthesize --text "hi" --json`,
    },
    {
      name: "voice",
      description:
        "Set the TTS voice for the currently active provider (routes to the right config key automatically)",
      arguments: [
        {
          name: "[id...]",
          description:
            "Voice/model id to set (joined with spaces). ElevenLabs voice id for elevenlabs; managed voice model id (ElevenLabs id or Deepgram Aura model like aura-2-thalia-en) for vellum; Aura model id for deepgram",
        },
      ],
      options: [
        {
          flags: "--json",
          description:
            "Output a single-line JSON object on stdout instead of a plain message",
        },
      ],
      helpText: `
Set the assistant's TTS voice on whichever provider is currently active
(services.tts.provider). This writes to the config key that provider actually
reads — e.g. services.tts.providers.vellum.model for managed speech — so the
change takes effect on the next spoken turn.

Prefer this over 'assistant config set services.tts.providers.elevenlabs.voiceId'
directly: on a managed (vellum) assistant that field is ignored, so the voice
would silently not change.

Examples:
  $ assistant tts voice pqHfZKP75CvOlQylNhV4      # ElevenLabs voice id (also valid on managed)
  $ assistant tts voice aura-2-thalia-en          # Deepgram Aura model (managed/deepgram)
  $ assistant tts voice aura-2-zeus-en --json`,
    },
  ],
};
