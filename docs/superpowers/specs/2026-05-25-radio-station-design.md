# Assistant Radio Station Design

Date: 2026-05-25

## Summary

Build a small, whimsical radio-station proof behind a web UI feature flag. The first slice is a global app station surfaced as a tiny expandable composer pill in chat. The assistant owns song choice, DJ copy, and DJ text-to-speech through backend orchestration; the browser owns media playback and crossfades.

This is intentionally not a full social radio product. V1 proves the feel: real demo tracks, an audible AI DJ between songs, backend-owned track selection, and a clear setup path when Text-to-Speech is not configured.

## Goals

- Add a tiny `On Air` composer pill that can expand, hide, play/pause, and show what is happening.
- Play real demo-safe music tracks from server-owned metadata and committed permissive assets or static asset references.
- Let the assistant choose the next track from the backend catalog.
- Generate short DJ breaks with a new LLM call site for usage tracking.
- Synthesize DJ speech through existing `services.tts` configuration.
- Support simple ducking/crossfade behavior so DJ narration can speak over music and transition into the next track.
- Provide a polished setup-needed state that links users to `/assistant/settings/ai`.

## Non-Goals

- No callers, call-in queue, assistant-to-assistant calls, or multi-listener presence.
- No Spotify, Apple Music, or external music-provider integration in V1.
- No server-pushed broadcast/SSE loop in V1.
- No cleanup of the current browser-local Text-to-Speech settings implementation unless needed for a narrow integration bug.
- No durable station history or preference-learning pipeline beyond local station session state.

## User Experience

The radio appears in chat as a compact composer pill when the web UI feature flag is enabled. The backend does not need to check this flag in V1; the flag only controls whether the UI is exposed.

Collapsed examples:

- `On Air · Song · 1:12`
- `On Air · DJ`
- `Cueing next break`
- `TTS setup needed`

Expanded popover:

- current and upcoming track title, artist, and source label
- progress and countdown
- simple display cue: song, DJ, transition, setup needed, or error
- DJ transcript while the spoken break plays
- play/pause, skip, minimize/hide
- setup CTA that opens `routes.settings.ai` (`/assistant/settings/ai`) when TTS is missing or invalid

The station is global to the web app, not scoped to the current conversation. It follows the user across chats while the current app session is alive.

## Backend Ownership

Add a small assistant-side `radio` module. Its responsibilities:

- own the demo track catalog and validate track choices
- expose the station advance endpoint
- call the LLM to choose the next track and write the DJ break
- synthesize the DJ break with `services.tts`
- return a transition plan for the browser player
- keep recent station context in memory for the current app session

The browser must not contain the authoritative music catalog. For V1, the backend catalog can be a small static list backed by committed demo-safe audio assets. Each track must include source/license notes and use a license compatible with this MIT project.

Future external providers should fit behind the same backend ownership model: the assistant chooses a track reference, and the appropriate player/provider layer handles playback.

## API Sketch

The web app calls a per-assistant runtime route through the existing gateway proxy, for example:

`POST /v1/assistants/{assistant_id}/radio/advance/`

Request:

```ts
interface RadioAdvanceRequest {
  reason: "start" | "song_ended" | "skip" | "retry";
  segmentId?: string;
  playbackPositionMs?: number;
}
```

Response:

```ts
interface RadioAdvanceResponse {
  segmentId: string;
  displayCue: "song" | "dj" | "transition" | "setup_needed" | "error";
  currentTrack?: RadioTrack;
  nextTrack: RadioTrack;
  djBreak?: {
    text: string;
    audioUrl?: string;
    durationMs?: number;
  };
  playbackPlan: {
    duckCurrentTrackTo: number;
    duckFadeMs: number;
    nextTrackFadeInMs: number;
    startNextTrackAfterMs?: number;
  };
  setup?: {
    reason: "tts_not_configured" | "tts_auth_failed" | "tts_unavailable";
    settingsPath: "/assistant/settings/ai";
  };
}

interface RadioTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  audioUrl: string;
  sourceLabel: string;
}
```

The backend should return music as metadata plus a playable URL/reference. It should not send music blobs for normal playback.

DJ audio may be returned as a short generated audio URL/reference, since it is per-break and synthesized from text. The implementation can reuse existing audio-serving patterns if they fit, or add a radio-local generated-audio store if that is cleaner.

## Playback Flow

1. User clicks the composer pill.
2. Web calls `advance` with `reason: "start"`.
3. Backend returns the initial track and a transition plan.
4. Browser plays the track.
5. Near the end of the track, browser calls `advance` with `reason: "song_ended"` or prefetches for the expected transition.
6. Backend calls the `radioDj` LLM call site to choose the next track and write a short DJ break.
7. Backend synthesizes the DJ break through `services.tts`.
8. Browser ducks the outgoing song, plays the DJ break, and fades in the next song according to the plan.

The client drives timing because it is the actual media player and knows about pauses, buffering, autoplay restrictions, tab sleep, and user skips. The backend owns what to play and say next.

SSE is intentionally out of scope for V1. It becomes useful later for multi-listener broadcast state, live call-ins, or server-pushed queue events.

## DJ Call Site

Add a new LLM call site, `radioDj`, so DJ usage is measurable separately from the main agent and other background features.

Required wiring:

- add `radioDj` to `LLMCallSiteEnum`
- add a `CALL_SITE_DEFAULTS.radioDj` entry with `profile: "balanced"` so it uses the shipped Balanced profile rather than the cost-optimized profile
- add call-site catalog metadata with display name `Radio DJ`
- call `getConfiguredProvider("radioDj")` from the radio planner

The planner prompt should ask the assistant to behave like a concise radio host: choose the next track from the available backend-provided candidates and write a short spoken transition. It may use normal model/tool behavior to gather timely or local context when useful. Do not add a deterministic news/sports/local-politics context provider for V1.

The endpoint may take a noticeable amount of time. The UI should show `Cueing next break` and prefetch before the song ends when possible.

## TTS Setup

Radio relies on the assistant runtime `services.tts` configuration, not browser-local Text-to-Speech settings. Managed TTS is not supported today; beta users are expected to configure their own provider first.

If TTS is missing or invalid, the backend should return a structured setup-needed response instead of a generic failure. The UI should show a clear CTA:

`Configure Text-to-Speech`

The CTA opens `/assistant/settings/ai`.

This design deliberately avoids broad cleanup of the current browser-local TTS settings flow. That cleanup can be a separate follow-up unless this feature exposes a narrow bug that must be fixed.

## Error Handling

- Missing TTS config: return `setup_needed` with `tts_not_configured`.
- TTS auth/provider failure: return `setup_needed` or `error` with a user-readable message and settings CTA.
- LLM planning failure: show retry; keep or restart music rather than advancing to an invalid segment.
- Invalid track choice from LLM: backend rejects it and falls back to a safe deterministic track choice or retries once.
- Track playback failure in browser: show skip/retry in the popover.
- Duplicate/late advance calls: backend accepts only the latest known segment where practical and returns a current plan instead of corrupting station state.

## Testing

Backend tests:

- radio catalog only exposes valid, licensed demo tracks
- `advance(start)` returns a playable track and segment id
- `advance(song_ended)` calls `radioDj`, validates the selected track, and returns a DJ break plus next track
- invalid LLM track ids are rejected and recovered
- missing TTS maps to setup-needed response
- TTS synthesis errors produce structured responses
- `radioDj` is included in call-site schema/default/catalog coverage

Web tests:

- composer pill is hidden when the UI feature flag is off
- collapsed and expanded pill states render correctly
- setup-needed state opens Settings -> AI
- playback controller applies ducking/fade instructions
- ended/skip events call `advance` with the right reason
- errors show retry/skip/setup affordances without breaking chat composer layout

Manual QA:

- desktop and mobile-width chat layouts
- browser autoplay behavior
- pause/resume around a DJ break
- song failure and TTS setup-needed paths

## Follow-Ups

- Replace demo catalog with provider-backed music search/playback.
- Add listener/call-in queue and assistant-to-assistant callers.
- Add durable station preferences if passive/explicit signals prove useful.
- Consider SSE or a true broadcast session once multiple listeners or server-pushed events exist.
- Clean up browser-local Text-to-Speech settings and align web settings with `services.tts`.
