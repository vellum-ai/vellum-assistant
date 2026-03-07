---
name: transcribe
description: Transcribe audio and video files using Whisper (cloud API or local)
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🎙️","vellum":{"display-name":"Transcribe"}}
---

Transcribe audio and video files using OpenAI's Whisper model — either via the cloud API or locally via whisper.cpp.

## Choosing a Mode

Before transcribing, **ask the user which mode they prefer** if they haven't specified:

1. **`api`** — Uses the OpenAI Whisper API. Fast, accurate, no setup needed. Requires an OpenAI API key (check if one is already configured). Audio is sent to OpenAI's servers. Costs ~$0.006/min.
2. **`local`** — Uses whisper.cpp installed via Homebrew. Free, private, runs entirely on-device. Requires a one-time `brew install whisper-cpp`. Slightly slower but no data leaves the machine.

If the user says "cloud", "API", or "online" → use `api`.
If the user says "local", "offline", "private", or "on-device" → use `local`.

## Usage Notes

- The tool accepts either a `file_path` (absolute path to a local file) or an `attachment_id` (for uploaded attachments). Prefer `file_path` when the user references a file on disk.
- Supported formats: any video (mp4, mov, etc.) or audio (mp3, wav, m4a, etc.) file.
- For video files, audio is automatically extracted via ffmpeg before transcription.
- The API mode has a 25MB per-request limit — large files are automatically split into chunks.
- Local mode requires whisper.cpp (`brew install whisper-cpp`). The model is downloaded automatically on first use.
