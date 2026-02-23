---
name: "Media Processing"
description: "Ingest and process media files (video, audio, image) through multi-stage pipelines"
metadata: {"vellum": {"emoji": "🎬"}}
---

Ingest and track processing of media files (video, audio, images) through configurable multi-stage pipelines.

## Tools

### ingest_media

Register a media file for processing. Accepts an absolute file path, validates the file exists, detects MIME type, extracts duration (for video/audio via ffprobe), and registers the asset with content-hash deduplication.

### media_status

Query the processing status of a media asset. Returns the asset metadata along with per-stage progress details.

## Usage Notes

- The `ingest_media` tool requires an absolute path to a local file.
- Supported media types: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), and images (png, jpg, gif, webp, etc.).
- For video and audio files, duration is automatically extracted via ffprobe (requires ffmpeg to be installed).
- Duplicate files are detected by content hash and return the existing asset record.
- After ingestion, processing stages are tracked in the database. Use `media_status` to monitor progress.
