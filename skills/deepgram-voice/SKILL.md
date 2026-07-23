---
name: deepgram-voice
description: Select and tune a Deepgram TTS voice - curated voice list, full Aura voice catalog via API key, and tuning parameters
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🎤"
  vellum:
    category: "voice"
    display-name: "Deepgram Voice"
---

## Overview

Deepgram provides text-to-speech voices (the **Aura** model family) for both **in-app TTS** and **phone calls**. Change the voice with the **`voice_config_update`** tool — it writes the voice to **whichever TTS provider is currently active** and pushes to the macOS app via SSE in one call:

```
voice_config_update setting="tts_voice_id" value="<aura-model-id>"
```

> **The voice lives under the _active_ provider, not always Deepgram.** The config key depends on `services.tts.provider`: `deepgram` → `services.tts.providers.deepgram.model`, `vellum` (managed) → `services.tts.providers.vellum.model`, `elevenlabs` → `services.tts.providers.elevenlabs.voiceId`. The `voice_config_update` tool (and the `assistant tts voice <id>` CLI command) handle this routing for you. **Do NOT `assistant config set services.tts.providers.deepgram.model ...` blindly** — on a managed (`vellum`) assistant that field is ignored, so the write "succeeds" but the voice never changes. See [Setting the voice](#setting-the-voice) for the CLI fallback.
>
> **The tables below apply when the active provider is `deepgram` (BYO key) or managed `vellum`.** Managed assistants synthesize Deepgram voices through the platform — the platform bills per rate-carded model and rejects voices it does not offer (the write succeeds but the voice fails on the next turn), so stick to current Aura-2 voices there. With a BYO key ([setup below](#deepgram-api-key-setup)), any Aura model id from the catalog works. Other BYO TTS providers (`elevenlabs`, `xai`, `fish-audio`, …) use their own voice identifiers — never write a Deepgram Aura model id to them; see [Getting to a Deepgram voice from another provider](#getting-to-a-deepgram-voice-from-another-provider).

## Getting to a Deepgram voice from another provider

Check the active provider first: `assistant config get services.tts.provider`.

- **Already on managed `vellum`?** No provider change needed. The managed platform supports **both Deepgram and ElevenLabs voices** — `services.tts.providers.vellum.model` accepts either an Aura model id or an ElevenLabs voice id, so switching between a Deepgram and an ElevenLabs voice is just another `voice_config_update` call.
- **On a BYO provider (e.g. `elevenlabs`) and the user wants a Deepgram voice?** Two options — ask which they prefer:
  1. **Switch to managed `vellum`** (`assistant config set services.tts.provider vellum`) — no Deepgram key needed; requires a platform connection and bills managed credits. Bonus: they keep access to both the Deepgram and ElevenLabs catalogs.
  2. **Switch to BYO `deepgram`** (`assistant config set services.tts.provider deepgram`) — requires a Deepgram API key ([setup below](#deepgram-api-key-setup)); usage bills their Deepgram account directly.

After either switch, set the voice with `voice_config_update` as usual.

## Choose a Voice

Pick a voice that matches your identity and the user's preferences. Offer to show the full list if they want to choose themselves. All voice ids follow the pattern `aura-2-<name>-en`.

### Female voices

| Voice  | Style                                  | Model ID           |
| ------ | -------------------------------------- | ------------------ |
| Thalia | Clear, confident, energetic (American) | `aura-2-thalia-en` |
| Luna   | Friendly, natural, engaging (American) | `aura-2-luna-en`   |
| Athena | Calm, smooth, professional (American)  | `aura-2-athena-en` |
| Hera   | Warm, smooth, professional (American)  | `aura-2-hera-en`   |

### Male voices

| Voice    | Style                                     | Model ID             |
| -------- | ----------------------------------------- | -------------------- |
| Zeus     | Deep, trustworthy, smooth (American)      | `aura-2-zeus-en`     |
| Orion    | Approachable, calm, polite (American)     | `aura-2-orion-en`    |
| Arcas    | Natural, smooth, comfortable (American)   | `aura-2-arcas-en`    |
| Apollo   | Confident, casual, comfortable (American) | `aura-2-apollo-en`   |
| Draco    | Warm, trustworthy, baritone (British)     | `aura-2-draco-en`    |
| Hyperion | Caring, warm, empathetic (Australian)     | `aura-2-hyperion-en` |

> These are **Aura-2** voices — Deepgram's current generation. First-generation ids (`aura-asteria-en`, `aura-orion-en`, … without the `-2-`) still work with a BYO key but sound noticeably flatter; prefer Aura-2 unless the user asks otherwise. `aura-2-thalia-en` is the managed platform's default voice.

### Setting the voice

**Preferred — the tool.** It writes to the active provider's voice field **and** pushes to the macOS app via SSE (`ttsVoiceId`) in one call:

```
voice_config_update setting="tts_voice_id" value="<selected-model-id>"
```

**CLI fallback (only if the `voice_config_update` tool is unavailable).** Use `assistant tts voice`, which routes to the active provider's config key for you — do **not** hand-write `assistant config set services.tts.providers.deepgram.model ...`:

```bash
assistant tts voice "<selected-model-id>"
```

Setting `services.tts.providers.deepgram.model` directly while the active provider is `vellum` (or any non-deepgram provider) is the #1 cause of "I changed the voice but it didn't change" — that field is ignored by the active provider, so the write reports success but nothing changes. If you must use `config set`, first check `assistant config get services.tts.provider` and write the matching key (`vellum` → `services.tts.providers.vellum.model`, `deepgram` → `services.tts.providers.deepgram.model`).

Verify it worked by reading back the key for the **active** provider, e.g. for a managed assistant:

```bash
assistant config get services.tts.providers.vellum.model
```

The change hot-applies to the next voice turn (live voice and phone read the config fresh each turn).

Tell the user what voice you chose and why, but also offer to show all available voices so they can choose for themselves.

## Deepgram API Key Setup

When the active provider is `vellum` (managed), no key is needed — the platform handles Deepgram synthesis and billing. A key is only required when the provider is `deepgram` (BYO key), or for [browsing the full catalog](#advanced-voice-selection-with-api-key). Get one at https://console.deepgram.com (free credit available).

To collect the API key securely:

```bash
assistant credentials prompt --service deepgram --field api_key --label "Deepgram API Key"
```

The same key is shared with Deepgram speech-to-text — storing it once covers both.

## Advanced Voice Selection (with API key)

Users with a Deepgram API key can go beyond the curated list above.

### Check for an existing key

```bash
assistant credentials inspect --service deepgram --field api_key --json
```

### Browse the voice library

Deepgram's models endpoint returns the full TTS catalog, including each voice's characteristics and accent:

```bash
curl -s "https://api.deepgram.com/v1/models" \
  -H "Authorization: Token $(assistant credentials reveal --service deepgram --field api_key)" \
  | python3 -c "import json,sys; [print(m['canonical_name'], '-', m['metadata']['accent'], '-', ', '.join(m['metadata']['tags'])) for m in json.load(sys.stdin)['tts'] if m['architecture']=='aura-2']"
```

### Search for a specific style

Filter the same response by tag or accent (tags include descriptors like `feminine`, `masculine`, `warm`, `casual`, plus accents like `British`, `Australian`, `Irish`, and non-English-accented voices e.g. Spanish or Filipino):

```bash
curl -s "https://api.deepgram.com/v1/models" \
  -H "Authorization: Token $(assistant credentials reveal --service deepgram --field api_key)" \
  | python3 -c "
import json, sys
query = 'warm british'.lower().split()
for m in json.load(sys.stdin)['tts']:
    if m['architecture'] != 'aura-2': continue
    hay = ' '.join([m['metadata']['accent'], *m['metadata']['tags']]).lower()
    if all(q in hay for q in query):
        print(m['canonical_name'], '-', m['metadata']['accent'], '-', ', '.join(m['metadata']['tags']))
"
```

### Preview voices

Each voice in the models response includes a `metadata.sample` URL with an audio clip the user can listen to before deciding. To synthesize a custom preview line:

```bash
curl -s -X POST "https://api.deepgram.com/v1/speak?model=<model-id>" \
  -H "Authorization: Token $(assistant credentials reveal --service deepgram --field api_key)" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hi! This is what I would sound like as your assistant."}' \
  -o scratch/voice-preview.mp3
```

### Set the chosen voice

After the user picks a voice from the catalog:

```
voice_config_update setting="tts_voice_id" value="<selected-model-id>"
```

## Voice Tuning

Deepgram Aura has no speed/stability/similarity parameters — expressiveness is baked into each voice, so if the sound isn't right, switch voices rather than hunting for a knob. The only tunable is the output format used for call/runtime playback **when the active provider is `deepgram`**:

```bash
# Output audio format: mp3 (default), wav, or opus
assistant config set services.tts.providers.deepgram.format mp3
```

## Voice Model Tuning

There is no separate model-id setting — the voice id **is** the model id, and the generation is part of it: `aura-2-*` ids use Aura-2, bare `aura-*-en` ids use first-generation Aura. To move a voice between generations, change the id itself, e.g. `aura-asteria-en` (Aura-1) → `aura-2-asteria-en` (Aura-2). Managed (`vellum`) assistants should always use Aura-2 ids — the platform only rate-cards current models.
