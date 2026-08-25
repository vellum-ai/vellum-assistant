---
name: voice-setup
description: Complete voice configuration in chat - desktop Talk and PTT shortcuts, microphone permissions, ElevenLabs/Deepgram TTS, and troubleshooting
compatibility: "Designed for Vellum personal assistants"
metadata:
  icon: assets/icon.svg
  emoji: "🎙️"
  vellum:
    platforms:
      - macos
      - windows
    category: "voice"
    display-name: "Voice Setup"
    includes: ["elevenlabs-voice", "deepgram-voice"]
    activation-hints:
      - "Guided setup or troubleshooting (walkthrough, PTT not working, mic issues, ElevenLabs/Deepgram/TTS)"
      - "Simple voice setting changes (PTT key, wake word) -> use voice_config_update directly"
    avoid-when:
      - 'If "voice" is in a Twilio/phone context, load phone-calls instead'
---

You are helping the user set up and troubleshoot voice features entirely within this conversation. Use the `client_os:` line in `<turn_context>` to choose the macOS or Windows instructions below. Do not give macOS commands or key names to a Windows user, or Windows guidance to a macOS user.

## Available Tools

- `voice_config_update` changes shared voice settings such as the legacy PTT activation key, conversation timeout, speech providers, and TTS voice ID.
- `open_system_settings` opens the correct macOS System Settings or Windows Settings privacy page. Always pass `platform` from the current `client_os` context.
- `navigate_settings_tab` opens Vellum settings. Use it for review, or when the desktop-owned Talk shortcut must be recorded in the app.
- `assistant credentials prompt` collects API keys securely for ElevenLabs or Deepgram.

The desktop Talk shortcut is client-owned. On current desktop clients, configure it in the Voice settings shortcut control instead of treating `voice_config_update setting="activation_key"` as a global shortcut editor. Use `voice_config_update` for the shared settings it owns. Use `activation_key` only when the user explicitly wants the legacy PTT activation setting, whose supported values are `fn`, `ctrl`, `fn_shift`, and `none`.

## Setup Flow

Walk through each relevant section in order. Skip sections the user does not need, and ask before moving to the next section.

### 1. Microphone Permission

Check `<channel_capabilities>` for `microphone_permission_granted`.

If it is `false` or missing:

1. Explain that the desktop app needs microphone permission for dictation and voice conversations.
2. Call `open_system_settings` with `pane: "microphone"` and the current `platform`.
3. Give the matching instruction:
   - **macOS:** In **System Settings > Privacy & Security > Microphone**, turn on **Vellum** or **Vellum Assistant**.
   - **Windows:** In **Settings > Privacy & security > Microphone**, turn on **Microphone access** and **Let desktop apps access your microphone**. Windows groups non-packaged desktop apps under the desktop-app toggle rather than always showing an individual Vellum switch.
4. Ask the user to return after changing it. Verify capabilities again on the next turn.

If it is `true`, confirm that microphone access is already granted and continue.

### 2. Talk and Push-to-Talk Shortcut

First determine whether the user means the current desktop **Talk** shortcut or the legacy PTT activation setting.

#### Desktop Talk shortcut

The Talk shortcut starts or ends a voice conversation.

- **macOS:** Offer **Fn** or a custom global chord. Fn is the Mac-specific helper path and can require Input Monitoring. If macOS refuses Fn registration, direct the user to **System Settings > Privacy & Security > Input Monitoring**, then have them reopen Vellum. A custom chord should be one the user can spare system-wide.
- **Windows:** Fn is unavailable because Windows does not receive the hardware Fn key. Recommend a custom chord for system-wide Talk. The app also offers **Ctrl+Shift** and **Alt** taps, but those bare-modifier choices work only while a Vellum window is focused. Warn that another global shortcut can prevent a custom chord from registering.

Ask which behavior they want, then use `navigate_settings_tab` with `tab: "Voice"` so they can record the desktop-owned shortcut. Do not claim that `voice_config_update` changed this shortcut.

#### Legacy PTT activation setting

If the user explicitly wants the legacy hold-to-talk setting, offer only values accepted by `voice_config_update`:

- **macOS:** `fn`, `fn_shift`, `ctrl`, or `none`
- **Windows:** `ctrl` or `none`; do not offer Fn

After the user chooses, call `voice_config_update` with `setting: "activation_key"` and the matching canonical value.

### 3. Text-to-Speech Voice (Optional)

Ask whether the user wants high-quality text-to-speech voices through ElevenLabs or Deepgram. Standard TTS works without this optional setup.

The included **ElevenLabs Voice** and **Deepgram Voice** skills provide the provider-specific setup flow, including API key collection, voice selection, and tuning.

Check the active provider first with `assistant config get services.tts.provider`. `voice_config_update` writes the voice to the active provider, and each bring-your-own provider accepts its own voice IDs. If the preferred provider does not match the active provider, collect any required API key before switching:

```text
voice_config_update setting="tts_provider" value="deepgram"
```

The managed `vellum` provider accepts both supported ElevenLabs and Deepgram voice IDs, so it does not require a provider switch. Then follow the matching included voice skill.

The active provider's voice setting controls both in-app TTS and phone calls.

### 4. Verification

After setup:

1. Summarize the configured permissions, shortcut, and provider settings.
2. Ask the user to test the selected shortcut and speak a short sentence.
3. Offer to open the Voice settings tab for review with `navigate_settings_tab` and `tab: "Voice"`.

On Windows, the native helper provides local dictation partials and final transcription. If the user sees recording start but gets no text, treat the shortcut and microphone as working and troubleshoot the helper or recognizer next.

## Troubleshooting Decision Trees

### "PTT isn't working" or "Can't record"

1. Check `microphone_permission_granted`. If it is false, follow the microphone permission flow.
2. Confirm whether the user configured desktop Talk or legacy PTT, and verify the selected shortcut in the Voice tab.
3. Apply the platform-specific checks:
   - **macOS:** Fn requires the native helper and may require Input Monitoring. The Globe key can also be assigned to macOS Dictation or the emoji picker, so suggest a custom chord if both actions fire.
   - **Windows:** Fn cannot work. A Ctrl+Shift or Alt tap requires Vellum to be focused. For use from another app, record a custom global chord and make sure no other app owns it.
4. Check Speech Recognition permission. Call `open_system_settings` with `pane: "speech_recognition"` and the current `platform` when it is denied or not determined.
5. If the Windows shortcut fires but capture does not start, restart the Windows helper from the Vellum tray menu and retry.

### "Recording but no text" or "Transcription not working"

1. Open the platform's Speech Recognition privacy page with `open_system_settings` if permission is denied or unknown.
2. Ask whether the recording indicator appears. If it does, microphone capture is active and the failure is downstream.
3. Check the spoken language:
   - **macOS:** Speech recognition works best when the system recognition language matches the speaker.
   - **Windows:** The local helper uses an installed Windows speech recognizer, preferring the current Windows display language. If no matching recognizer is installed, add the language's speech feature in Windows language settings or select an installed language.
4. Reduce background noise or move closer to the microphone.
5. On Windows, restart the helper from the tray menu. The helper performs on-device dictation and can recover independently of the assistant process.

### "Changed a setting but it didn't work"

1. Shared `voice_config_update` changes should apply immediately. Verify the persisted value with the relevant config command.
2. Desktop shortcut changes are stored by the desktop client. Reopen the Voice tab and confirm the Talk shortcut shown there.
3. If the displayed value is correct but behavior is stale, restart Vellum and retry.

## Deep Debugging

For persistent issues, use the matching log path.

**macOS:**

```bash
log stream --predicate 'subsystem == "com.vellum.assistant"' --level debug
```

Look for `voice` and `speech` categories.

**Windows PowerShell:**

```powershell
$log = Get-ChildItem "$env:APPDATA\Vellum*\logs\vellum.log" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
Get-Content $log.FullName -Wait
```

Look for `[win-helper]`, `dictation`, permission, and global shortcut registration messages. Do not ask the user to share transcript contents from logs.

## Rules

- Handle every tool-backed setting conversationally in chat.
- Use `navigate_settings_tab` for review and for the desktop-owned Talk shortcut, which must be recorded in the client.
- Use platform-specific Settings names and shortcuts.
- Be concise. Present the common choices and let the user ask for more.
- If permission is denied, acknowledge it and explain which voice features will remain unavailable.
