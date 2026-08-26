/**
 * Declarative help for the `assistant stt` command.
 *
 * The advertised provider list is derived from the STT provider catalog, the
 * single source of truth for which providers exist and which boundaries they
 * serve, so the help cannot drift from what the daemon actually accepts.
 */

// provider-catalog is an execution-free data leaf (a literal map behind
// type-only imports, no adapter or credential graph), consumed synchronously
// to derive this module's constant. Pure data from pure data, so a lazy
// `import()` has nothing to defer.
// eslint-disable-next-line cli/no-daemon-internals
import {
  listSelectableProviderIds,
  supportsBoundary,
} from "../../providers/speech-to-text/provider-catalog.js";
import type { CliCommandHelp } from "../lib/cli-command-help.js";

/**
 * `stt transcribe` runs the `daemon-batch` boundary, so streaming-only
 * providers are omitted: naming one would advertise a configuration that
 * fails on every file.
 */
const batchProviders = listSelectableProviderIds()
  .filter((id) => supportsBoundary(id, "daemon-batch"))
  .join(", ");

export const sttHelp: CliCommandHelp = {
  name: "stt",
  description: "Speech-to-text operations",
  helpText: `
Speech-to-text commands use your configured STT provider to transcribe
audio and video files. The provider is set via:

  $ assistant config set services.stt.provider <provider>

Supported providers: ${batchProviders}.
Streaming-only providers serve live speech and cannot transcribe files.

Examples:
  $ assistant stt transcribe --file /path/to/meeting.wav
  $ assistant stt transcribe --file /path/to/video.mp4 --json`,
  subcommands: [
    {
      name: "transcribe",
      description: "Transcribe an audio or video file to text",
      options: [
        {
          flags: "--file <path>",
          description: "Absolute path to the audio/video file",
          required: true,
        },
        {
          flags: "--json",
          description:
            "Output structured JSON instead of plain transcript text",
        },
      ],
      helpText: `
Transcribes an audio or video file using the configured speech-to-text
provider. Video files automatically have their audio extracted via ffmpeg.
Large files (>25MB as WAV) are automatically split into chunks and
transcribed sequentially.

Supported audio formats: .mp3, .wav, .m4a, .aac, .ogg, .flac, .aiff, .wma
Supported video formats: .mp4, .mov, .avi, .mkv, .webm, .m4v, .mpeg, .mpg

Requires ffmpeg and ffprobe to be installed and on PATH.

Examples:
  $ assistant stt transcribe --file /path/to/recording.wav
  $ assistant stt transcribe --file /path/to/meeting.mp4
  $ assistant stt transcribe --file /path/to/podcast.mp3 --json`,
    },
  ],
};
