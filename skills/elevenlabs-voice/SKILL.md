---
name: elevenlabs-voice
description: Select and tune an ElevenLabs TTS voice — curated voice list, custom/cloned voices via API key, and tuning parameters
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🗣️"
  vellum:
    display-name: "ElevenLabs Voice"
    user-invocable: true
---

## Overview

ElevenLabs provides text-to-speech voices for both **in-app TTS** and **phone calls**. The shared config key `elevenlabs.voiceId` controls the voice across all channels. Use the `voice_config_update` tool to change the voice — it writes to the config file and pushes to the macOS app via SSE in one call.

## Choose a Voice

Pick a voice that matches the your identity and the user's preferences. Offer to show the full list if they want to choose themselves.

### Female voices

| Voice     | Style                      | Voice ID               |
| --------- | -------------------------- | ---------------------- |
| Rachel    | Calm, warm, conversational | `21m00Tcm4TlvDq8ikWAM` |
| Sarah     | Soft, young, approachable  | `EXAVITQu4vr4xnSDxMaL` |
| Charlotte | Warm, Swedish-accented     | `XB0fDUnXU5powFXDhCwa` |
| Alice     | Confident, British         | `Xb7hH8MSUJpSbSDYk0k2` |
| Matilda   | Warm, friendly, young      | `XrExE9yKIg1WjnnlVkGX` |
| Lily      | Warm, British              | `pFZP5JQG7iQjIQuC4Bku` |

### Male voices

| Voice   | Style                           | Voice ID               |
| ------- | ------------------------------- | ---------------------- |
| Antoni  | Warm, well-rounded              | `ErXwobaYiN019PkySvjV` |
| Josh    | Deep, young, clear              | `TxGEqnHWrfWFTfGW9XjX` |
| Arnold  | Crisp, narrative                | `VR6AewLTigWG4xSOukaG` |
| Adam    | Deep, middle-aged, professional | `pNInz6obpgDQGcFmaJgB` |
| Bill    | Trustworthy, American           | `pqHfZKP75CvOlQylNhV4` |
| George  | Warm, British, distinguished    | `JBFqnCBsd6RMkjVDRZzb` |
| Daniel  | Authoritative, British          | `onwK4e9ZLuTAKqWW03F9` |
| Charlie | Casual, Australian              | `IKne3meq5aSn9XLyUdCD` |
| Liam    | Young, articulate               | `TX3LPaxmHKxFdv7VOQHJ` |

### Setting the voice

To set the chosen voice, use `voice_config_update`. This writes to the config file (`elevenlabs.voiceId`) for phone calls **and** pushes to the macOS app via SSE (`ttsVoiceId`) for in-app TTS in one call:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

Verify it worked:

```bash
assistant config get elevenlabs.voiceId
```

Tell the user what voice you chose and why, but also offer to show all available voices so they can choose for themselves.

## ElevenLabs API Key Setup

For advanced voice selection (browsing the full library, custom/cloned voices), the user needs an ElevenLabs API key. A free tier is available at https://elevenlabs.io.

To collect the API key securely:

```
credential_store action="prompt" service="elevenlabs" field="api_key"
```

## Advanced Voice Selection (with API key)

Users with an ElevenLabs API key can go beyond the curated list above.

### Check for an existing key

```bash
assistant credentials inspect elevenlabs:api_key --json
```

### Browse the voice library

```bash
curl -s "https://api.elevenlabs.io/v2/voices?category=premade&page_size=50" \
  -H "xi-api-key: $(assistant credentials reveal elevenlabs:api_key)" | python3 -m json.tool
```

### Search for a specific style

```bash
curl -s "https://api.elevenlabs.io/v2/voices?search=warm+female&page_size=10" \
  -H "xi-api-key: $(assistant credentials reveal elevenlabs:api_key)" | python3 -m json.tool
```

### Custom and cloned voices

If the user has created a custom voice or voice clone in their ElevenLabs account, they can use its voice ID directly. These voices work in both in-app TTS and Twilio ConversationRelay.

### Preview voices

Each voice in the API response includes a `preview_url` with an audio sample the user can listen to before deciding.

### Set the chosen voice

After the user picks a voice from the library:

```
voice_config_update setting="tts_voice_id" value="<selected-voice-id>"
```

## Voice Tuning

Fine-tune how the selected voice sounds. These parameters apply to all ElevenLabs modes (in-app TTS and phone calls):

```bash
# Playback speed (0.7 = slower, 1.0 = normal, 1.2 = faster)
assistant config set elevenlabs.speed 1.0

# Stability (0.0 = more expressive/variable, 1.0 = more consistent/monotone)
assistant config set elevenlabs.stability 0.5

# Similarity boost (0.0 = more creative, 1.0 = closer to original voice)
assistant config set elevenlabs.similarityBoost 0.75
```

Lower stability makes the voice more expressive but less predictable — good for conversational calls. Higher stability is better for scripted or formal contexts.

## Voice Model Tuning

By default, the system sends a **bare** `voiceId` to Twilio ConversationRelay (no model/tuning suffix). This is the safest default across voice IDs.

To optionally force Twilio's extended voice spec, set a model ID:

```bash
assistant config set elevenlabs.voiceModelId "flash_v2_5"
```

When `voiceModelId` is set, the emitted voice string becomes: `voiceId-model-speed_stability_similarity`.

To clear and revert to the bare voiceId default:

```bash
assistant config set elevenlabs.voiceModelId ""
```
