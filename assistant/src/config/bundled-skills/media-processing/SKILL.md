---
name: "Media Processing"
description: "Ingest and process media files (video, audio, image) through multi-stage pipelines including keyframe extraction, vision analysis, and timeline generation"
metadata: {"vellum": {"emoji": "🎬"}}
---

Ingest and track processing of media files (video, audio, images) through configurable multi-stage pipelines.

## Tools

### ingest_media

Register a media file for processing. Accepts an absolute file path, validates the file exists, detects MIME type, extracts duration (for video/audio via ffprobe), and registers the asset with content-hash deduplication.

### media_status

Query the processing status of a media asset. Returns the asset metadata along with per-stage progress details.

### extract_keyframes

Extract keyframes from a video asset at regular intervals using ffmpeg. Frames are saved as JPEG images and registered in the database for subsequent vision analysis.

### analyze_keyframes

Analyze extracted keyframes using Claude VLM (vision language model). Produces structured JSON output with scene descriptions, subjects, actions, and context. Supports resumability by skipping already-analyzed frames.

### select_tracking_profile

Configure which event capabilities are enabled for a media asset. Capabilities are organized into tiers:
- **Ready**: Production-quality detection, included by default.
- **Beta**: Functional but may have accuracy gaps. Results include a confidence disclaimer.
- **Experimental**: Early-stage detection, expect noise. Results include a confidence disclaimer.

Call without capabilities to see available options; call with a capabilities array to set the profile.

## Services

### Timeline Generation

The timeline service (services/timeline-service.ts) aggregates vision analysis outputs into coherent timeline segments. Call `generateTimeline(assetId)` after keyframe analysis is complete to produce a structured timeline.

### Capability Registry

The capability registry (services/capability-registry.ts) maintains an extensible, domain-agnostic catalog of available tracking capabilities with tier classification. Basketball capabilities are registered as one example domain. Other domains (surveillance, lecture recording, etc.) can register their own capabilities by calling `registerCapability()`.

## Usage Notes

- The `ingest_media` tool requires an absolute path to a local file.
- Supported media types: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), and images (png, jpg, gif, webp, etc.).
- For video and audio files, duration is automatically extracted via ffprobe (requires ffmpeg to be installed).
- Duplicate files are detected by content hash and return the existing asset record.
- After ingestion, processing stages are tracked in the database. Use `media_status` to monitor progress.
- Keyframe extraction requires ffmpeg. Vision analysis requires the ANTHROPIC_API_KEY environment variable.
- The `analyze_keyframes` tool is marked as medium risk because it makes external API calls to Claude VLM, which incur costs.
- All schema tables, services, and tool interfaces are media-generic. Domain-specific interpretation belongs in VLM prompt templates.
- The `select_tracking_profile` tool controls which event types are returned by `query_media_events`. Without a profile, only ready-tier capabilities are included.
- To enable beta or experimental capabilities for an asset: `select_tracking_profile({ asset_id: "...", capabilities: ["turnovers", "field_goals", "rebounds_per_player"] })`.
- The capability registry is extensible: call `registerCapability()` from `services/capability-registry.ts` to add capabilities for any domain.
