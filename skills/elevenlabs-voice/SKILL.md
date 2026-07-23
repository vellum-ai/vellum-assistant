---
name: elevenlabs-voice
description: Select and tune an ElevenLabs TTS voice - curated voice list, custom/cloned voices via API key, and tuning parameters
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🗣️"
  vellum:
    category: "voice"
    display-name: "ElevenLabs Voice"
---

## Overview

ElevenLabs provides text-to-speech voices for both **in-app TTS** and **phone calls**. Change the voice with the **`voice_config_update`** tool — it writes the voice to **whichever TTS provider is currently active** and pushes to the macOS app via SSE in one call:

```
voice_config_update setting="tts_voice_id" value="<voice-id>"
```

> **The voice lives under the _active_ provider, not always ElevenLabs.** The config key depends on `services.tts.provider`: `elevenlabs` → `services.tts.providers.elevenlabs.voiceId`, `vellum` (managed) → `services.tts.providers.vellum.model`, `deepgram` → `services.tts.providers.deepgram.model`. The `voice_config_update` tool (and the `assistant tts voice <id>` CLI command) handle this routing for you. **Do NOT `assistant config set services.tts.providers.elevenlabs.voiceId ...` blindly** — on a managed (`vellum`) assistant that field is ignored, so the write "succeeds" but the voice never changes. See [Setting the voice](#setting-the-voice) for the CLI fallback.
>
> **The tables below apply when the active provider is `elevenlabs` (BYO key) or managed `vellum`.** On managed assistants they are the _only_ ElevenLabs voices — the platform bills per rate-carded model and rejects anything else at synthesis (the write succeeds but the voice fails on the next turn), so don't offer library or cloned voices unless the assistant has its own ElevenLabs API key. With a BYO key ([setup below](#elevenlabs-api-key-setup)), any voice id works. Other TTS providers (`deepgram`, `xai`, `fish-audio`, …) use their own voice/model identifiers — never write an ElevenLabs voice id to them; pick from that provider's own catalog instead.

## Choose a Voice

Pick a voice that matches your identity and the user's preferences. Offer to show the full list if they want to choose themselves.

### Female voices

| Voice   | Style                     | Voice ID               |
| ------- | ------------------------- | ---------------------- |
| Sarah   | Soft, young, approachable | `EXAVITQu4vr4xnSDxMaL` |
| Alice   | Confident, British        | `Xb7hH8MSUJpSbSDYk0k2` |
| Matilda | Warm, friendly, young     | `XrExE9yKIg1WjnnlVkGX` |
| Lily    | Warm, British             | `pFZP5JQG7iQjIQuC4Bku` |

### Male voices

| Voice   | Style                           | Voice ID               |
| ------- | ------------------------------- | ---------------------- |
| Adam    | Deep, middle-aged, professional | `pNInz6obpgDQGcFmaJgB` |
| Bill    | Trustworthy, American           | `pqHfZKP75CvOlQylNhV4` |
| George  | Warm, British, distinguished    | `JBFqnCBsd6RMkjVDRZzb` |
| Daniel  | Authoritative, British          | `onwK4e9ZLuTAKqWW03F9` |
| Charlie | Casual, Australian              | `IKne3meq5aSn9XLyUdCD` |
| Liam    | Young, articulate               | `TX3LPaxmHKxFdv7VOQHJ` |

> These are ElevenLabs' **current premade** voices. Do not use retired legacy ids (Antoni, Josh, Arnold, Rachel, Charlotte, Amelia, …): ElevenLabs silently remaps them to _different_ voices — synthesis succeeds but speaks as the wrong voice.

### Setting the voice

**Preferred — the tool.** It writes to the active provider's voice field **and** pushes to the macOS app via SSE (`ttsVoiceId`) in one call:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

**CLI fallback (only if the `voice_config_update` tool is unavailable).** Use `assistant tts voice`, which routes to the active provider's config key for you — do **not** hand-write `assistant config set services.tts.providers.elevenlabs.voiceId ...`:

```bash
assistant tts voice "<selected-voice-id>"
```

Setting `services.tts.providers.elevenlabs.voiceId` directly while the active provider is `vellum` (or any non-elevenlabs provider) is the #1 cause of "I changed the voice but it didn't change" — that field is ignored by the active provider, so the write reports success but nothing changes. If you must use `config set`, first check `assistant config get services.tts.provider` and write the matching key (`vellum` → `services.tts.providers.vellum.model`, `deepgram` → `services.tts.providers.deepgram.model`).

Verify it worked by reading back the key for the **active** provider, e.g. for a managed assistant:

```bash
assistant config get services.tts.providers.vellum.model
```

The change hot-applies to the next voice turn (live voice and phone read the config fresh each turn).

Tell the user what voice you chose and why, but also offer to show all available voices so they can choose for themselves.

## ElevenLabs API Key Setup

For advanced voice selection (browsing the full library, custom/cloned voices), the user needs an ElevenLabs API key. A free tier is available at https://elevenlabs.io.

To collect the API key securely:

```bash
assistant credentials prompt --service elevenlabs --field api_key --label "ElevenLabs API Key"
```

## Advanced Voice Selection (with API key)

Users with an ElevenLabs API key can go beyond the curated list above.

### Check for an existing key

```bash
assistant credentials inspect --service elevenlabs --field api_key --json
```

### Browse the voice library

```bash
curl -s "https://api.elevenlabs.io/v2/voices?category=premade&page_size=50" \
  -H "xi-api-key: $(assistant credentials reveal --service elevenlabs --field api_key)" | python3 -m json.tool
```

### Search for a specific style

```bash
curl -s "https://api.elevenlabs.io/v2/voices?search=warm+female&page_size=10" \
  -H "xi-api-key: $(assistant credentials reveal --service elevenlabs --field api_key)" | python3 -m json.tool
```

### Custom and cloned voices

If the user has created a custom voice or voice clone in their ElevenLabs account, they can use its voice ID directly. These voices work in both in-app TTS and phone calls.

### Preview voices

Each voice in the API response includes a `preview_url` with an audio sample the user can listen to before deciding.

### Set the chosen voice

After the user picks a voice from the library:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

## Voice Tuning

Fine-tune how the selected voice sounds. These parameters apply to all ElevenLabs modes (in-app TTS and phone calls) **when the active provider is `elevenlabs`** — managed (`vellum`) synthesis does not read them:

```bash
# Playback speed (0.7 = slower, 1.0 = normal, 1.2 = faster)
assistant config set services.tts.providers.elevenlabs.speed 1.0

# Stability (0.0 = more expressive/variable, 1.0 = more consistent/monotone)
assistant config set services.tts.providers.elevenlabs.stability 0.5

# Similarity boost (0.0 = more creative, 1.0 = closer to original voice)
assistant config set services.tts.providers.elevenlabs.similarityBoost 0.75
```

Lower stability makes the voice more expressive but less predictable - good for conversational calls. Higher stability is better for scripted or formal contexts.

## Voice Model Tuning

By default, synthesis uses ElevenLabs' `eleven_multilingual_v2` model. To use a different model (e.g. a lower-latency one), set a model ID:

```bash
assistant config set services.tts.providers.elevenlabs.voiceModelId "eleven_flash_v2_5"
```

To clear and revert to the default model:

```bash
assistant config set services.tts.providers.elevenlabs.voiceModelId ""
```
