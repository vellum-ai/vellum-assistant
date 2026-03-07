---
name: "Voice Setup"
description: "Complete voice configuration in chat — PTT key, wake word, microphone permissions, ElevenLabs TTS, and troubleshooting"
user-invocable: true
metadata: {"vellum": {"emoji": "🎙️", "os": ["darwin"]}}
---

You are helping the user set up and troubleshoot voice features (push-to-talk, wake word, text-to-speech) entirely within this conversation. Do NOT direct the user to the Settings page for initial setup — handle everything in-chat using the tools below.

## Available Tools

- `voice_config_update` — Change any voice setting (PTT key, wake word enabled/keyword/timeout, TTS voice ID)
- `open_system_settings` — Open macOS System Settings to a specific privacy pane
- `navigate_settings_tab` — Open the Vellum settings panel to the Voice tab
- `credential_store` — Collect API keys securely (for ElevenLabs TTS)

## Setup Flow

Walk the user through each section in order. Skip sections they don't need. Ask before proceeding to the next section.

### 1. Microphone Permission

Check `<channel_capabilities>` for `microphone_permission_granted`.

**If `false` or missing:**
1. Explain that macOS requires microphone permission for voice features.
2. Use `open_system_settings` with `pane: "microphone"` to open the right System Settings pane.
3. Tell the user: "I've opened System Settings to the Microphone section. Please toggle **Vellum Assistant** on, then come back here."
4. After they confirm, verify by checking capabilities on the next turn.

**If `true`:** Tell them microphone is already granted and move on.

### 2. Push-to-Talk Activation Key

Present common PTT key options:
- **Right Option (⌥)** — Default, good general choice
- **Fn** — Dedicated key on most Mac keyboards
- **Right Command (⌘)** — Easy to reach
- **Right Control (⌃)** — Familiar from gaming

Ask which key they prefer, then use `voice_config_update` with `setting: "activation_key"` and the chosen value.

**Common issues to mention:**
- If they pick a key that conflicts with their emoji picker (Fn or Globe on newer Macs), warn them and suggest an alternative.
- If they use a terminal app heavily, warn that some keys may be captured by the terminal.

### 3. Wake Word (Optional)

Ask if they want to enable wake word detection (hands-free activation by saying a keyword).

**If yes:**
1. Use `voice_config_update` with `setting: "wake_word_enabled"`, `value: true`.
2. Ask what wake word they want. Common choices: "Hey Vellum", "Computer", "Jarvis", their assistant's name.
3. Use `voice_config_update` with `setting: "wake_word_keyword"` and their chosen word.
4. Ask about timeout (how long the mic stays active after wake word). Options: 5s, 10s (default), 15s, 30s, 60s.
5. Use `voice_config_update` with `setting: "wake_word_timeout"` and their chosen value.

**Speech Recognition permission:** Wake word requires Speech Recognition access. Check capabilities — if not granted, use `open_system_settings` with `pane: "speech_recognition"`.

### 4. Text-to-Speech / ElevenLabs (Optional)

Ask if they want high-quality text-to-speech voices via ElevenLabs (optional — standard TTS works without it).

**If yes:**
1. Tell them they need an ElevenLabs API key. They can get one at https://elevenlabs.io (free tier available).
2. Use `credential_store` with `action: "prompt"`, `service: "elevenlabs"`, `field: "api_key"` to show a secure input dialog.
3. After the key is stored, confirm success.

#### Choose an ElevenLabs voice

After storing the API key, let the user pick their preferred voice. The shared config key `elevenlabs.voiceId` controls the voice for **both** in-app TTS and phone calls (defaulting to Rachel).

Check the current voice:

```bash
assistant integrations voice config --json
```

Use `voiceId` from the response as the current selection (and `usesDefaultVoice` to know if Rachel is still in use by default). Ask the user if they want to change their TTS voice. If yes, use `voice_config_update` with `setting: "tts_voice_id"` and the chosen voice ID. This writes to both the config file (`elevenlabs.voiceId`) and pushes to the macOS app via IPC in one call.

Common choices from the curated ElevenLabs list:
- **Rachel** (`21m00Tcm4TlvDq8ikWAM`) — Calm, warm, conversational (default)
- **Sarah** (`EXAVITQu4vr4xnSDxMaL`) — Soft, young, approachable
- **Charlotte** (`XB0fDUnXU5powFXDhCwa`) — Warm, Swedish-accented
- **Josh** (`TxGEqnHWrfWFTfGW9XjX`) — Deep, young, clear
- **Adam** (`pNInz6obpgDQGcFmaJgB`) — Deep, middle-aged, professional

If the user wants to browse more voices, they can search at https://elevenlabs.io/voice-library or use the ElevenLabs API with their key.

#### Sync with phone calls

After setting the voice, check whether phone calls are configured:

```bash
assistant integrations voice config --json
```

**If phone calls are enabled** (`callsEnabled` is `true`):
- Tell the user their phone calls will automatically use the same voice they just chose, since both in-app TTS and phone calls read from `elevenlabs.voiceId`.

**If phone calls are not yet configured** (`callsEnabled` is `false`):
- Tell the user: "When you set up phone calls later, they'll automatically use the same voice for a consistent experience."

### 5. Verification

After setup is complete:
1. Summarize what was configured.
2. Suggest they test by pressing their PTT key (or saying their wake word) and speaking.
3. Offer to open the Voice settings tab if they want to review: use `navigate_settings_tab` with `tab: "Voice"`.

## Troubleshooting Decision Trees

When the user reports a problem, follow the appropriate decision tree:

### "PTT isn't working" / "Can't record"
1. **Microphone permission** — Check `microphone_permission_granted` in capabilities. If false, guide through granting it.
2. **Key check** — Ask what key they're using. Confirm it matches their configured PTT key.
3. **Emoji picker conflict** — On newer Macs, Fn/Globe opens the emoji picker. If they're using Fn, suggest switching to Right Option or Right Command.
4. **Speech Recognition permission** — Some voice features need this. Use `open_system_settings` with `pane: "speech_recognition"`.
5. **App focus** — PTT may not work when Vellum is not the frontmost app or if another app has captured the key.

### "Recording but no text" / "Transcription not working"
1. **Speech Recognition permission** — Must be granted for transcription.
2. **Microphone input** — Ask if they see the recording indicator. If yes, the mic works but transcription is failing.
3. **Locale/language** — Speech recognition works best with the system language. Ask if they're speaking in a different language.
4. **Background noise** — Excessive noise can prevent transcription. Suggest a quieter environment or a closer microphone.

### "Wake word not detecting"
1. **Enabled check** — Confirm wake word is enabled in their settings.
2. **Keyword** — Confirm what keyword they're using. Shorter or common words may have lower accuracy.
3. **Ambient noise** — Wake word detection is sensitive to background noise.
4. **Permissions** — Both Microphone and Speech Recognition permissions are required.
5. **Timeout** — If wake word activates but cuts off too quickly, increase the timeout.

### "Changed a setting but it didn't work"
1. **IPC broadcast** — The setting should take effect immediately. If it didn't, suggest restarting the assistant.
2. **Verify** — Open the Voice settings tab with `navigate_settings_tab` to confirm the setting was persisted.

## Deep Debugging

For persistent issues, suggest checking system logs:

```bash
log stream --predicate 'subsystem == "com.vellum.assistant"' --level debug
```

Key log categories:
- `voice` — PTT activation, recording state
- `wake-word` — Wake word detection events
- `speech` — Speech recognition results

## Rules

- Always handle setup conversationally in-chat. Do NOT tell the user to go to Settings for initial configuration.
- Use `navigate_settings_tab` only for review/verification after in-chat setup, not as the primary setup method.
- Be concise. Don't explain every option exhaustively — present the most common choices and let the user ask for more.
- If a permission is denied, acknowledge it gracefully and explain what features won't work without it.
