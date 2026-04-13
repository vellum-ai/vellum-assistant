---
name: transcribe
description: Transcribe audio and video files using the configured speech-to-text provider
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎙️"
  vellum:
    display-name: "Transcribe"
---

Transcribe audio and video files using the configured speech-to-text provider. Supports multiple STT providers including OpenAI Whisper and Deepgram — the active provider is selected in Settings under Speech-to-Text (`services.stt`).

## Usage Notes

- The tool accepts a `file_path` (absolute path to a local audio or video file) to transcribe.
- Supported formats: any video (mp4, mov, etc.) or audio (mp3, wav, m4a, etc.) file.
- For video files, audio is automatically extracted via ffmpeg before transcription.
- Large files are automatically split into chunks for processing.
- If no STT provider credentials are configured, the tool will return an error with setup instructions.
- The STT provider used here (`services.stt`) is independent of the telephony transcription provider (`calls.voice.transcriptionProvider`), which is configured separately for phone call STT.

## Maintenance

When adding or modifying an STT provider, follow the onboarding checklist at `assistant/docs/stt-provider-onboarding.md`. That document covers the daemon catalog, config schema, adapter wiring, client catalog parity, and required tests.
