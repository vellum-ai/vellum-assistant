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
      - linux
    category: "voice"
    display-name: "Voice Setup"
    includes: ["elevenlabs-voice", "deepgram-voice"]
    activation-hints:
      - "Guided setup or troubleshooting (walkthrough, PTT not working, mic issues, ElevenLabs/Deepgram/TTS)"
      - "Simple voice setting changes (legacy macOS PTT key, wake word) -> use voice_config_update directly"
    avoid-when:
      - 'If "voice" is in a Twilio/phone context, load phone-calls instead'
---

You are helping the user set up and troubleshoot voice features entirely within this conversation. Use the `client_os:` line in `<turn_context>` to choose the macOS, Windows, or Linux instructions below. Never give one platform's commands or key names to a user on another platform.

Before using a desktop tool, check `client_os`:

- If it is `macos`, `windows`, or `linux`, follow that platform's branch.
- If it is `web`, `ios`, `android`, or absent, do not call `open_system_settings` or give desktop shortcut instructions. Explain that permissions and the Talk shortcut must be configured from the Mac, Windows, or Linux desktop app. You can still complete provider, voice, language, and timeout configuration in the current conversation.

## Available Tools

- `voice_config_update` changes shared voice settings such as the legacy macOS PTT activation key, conversation timeout, speech providers, and TTS voice ID.
- `open_system_settings` opens the correct macOS System Settings or Windows Settings privacy page. Call it only when `client_os` is `macos`, `windows`, or `linux`, and pass that value as `platform`. On Linux there is no shared settings URI scheme, so the tool returns the desktop settings command to offer the user instead of opening a page. If the tool rejects `linux` on the user's build, do not retry: name the settings path for their desktop and continue.
- `navigate_settings_tab` opens Vellum settings. Use it for review, or when the desktop-owned Talk shortcut must be recorded in the app.
- `assistant credentials prompt` collects API keys securely for ElevenLabs or Deepgram.

The desktop Talk shortcut is client-owned. On current desktop clients, configure it in the Voice settings shortcut control instead of treating `voice_config_update setting="activation_key"` as a global shortcut editor. Use `voice_config_update` for the shared settings it owns. Use `activation_key` only for the legacy macOS PTT activation setting.

## Setup Flow

Walk through each relevant section in order. Skip sections the user does not need, and ask before moving to the next section.

### 1. Microphone Permission

Microphone permission is not reported in `<channel_capabilities>`. Ask whether Vellum shows a microphone permission warning or whether the user already granted access.

If access is denied or the user is unsure:

1. Explain that the desktop app needs microphone permission for dictation and voice conversations.
2. Call `open_system_settings` with `pane: "microphone"` and the current `platform`.
3. Give the matching instruction:
   - **macOS:** In **System Settings > Privacy & Security > Microphone**, turn on **Vellum** or **Vellum Assistant**.
   - **Windows:** In **Settings > Privacy & security > Microphone**, turn on **Microphone access** and **Let desktop apps access your microphone**. Windows groups non-packaged desktop apps under the desktop-app toggle rather than always showing an individual Vellum switch.
   - **Linux:** There is no per-app microphone toggle on most desktops. Open the desktop's sound settings, GNOME Settings > Sound or System Settings > Audio on KDE, and check the input tab for the right device, an unmuted level, and an input meter that moves while the user speaks. If the session routes capture through a portal, the first recording shows a portal prompt the user has to allow.
4. Ask the user to return after changing it, then verify with the short recording test in section 4.

If the user confirms access is granted, continue without opening system settings.

### 2. Talk and Push-to-Talk Shortcut

On macOS, first determine whether the user means the current desktop **Talk** shortcut or the legacy PTT activation setting. Windows and Linux support the desktop Talk shortcut only.

#### Desktop Talk shortcut

The Talk shortcut starts or ends a voice conversation.

- **macOS:** Offer **Fn** or a custom global chord. Fn is the Mac-specific helper path and can require Input Monitoring. If macOS refuses Fn registration, direct the user to **System Settings > Privacy & Security > Input Monitoring**, then have them reopen Vellum. A custom chord should be one the user can spare system-wide.
- **Windows:** Fn is unavailable because Windows does not receive the hardware Fn key. Recommend a custom chord for system-wide Talk. The app also offers **Ctrl+Shift** and **Alt** taps, but those bare-modifier choices work only while a Vellum window is focused. Warn that another global shortcut can prevent a custom chord from registering.
- **Linux:** Fn is unavailable for the same reason. A custom chord is the only working option: the client registers it as a global shortcut through the desktop session. Do not offer **Ctrl+Shift** or **Alt**, because Linux rejects modifier-only bindings entirely, focused or not. Those need the native helper's keyboard monitor, which no current Linux build ships, so do not send anyone through host permission changes for them yet. Warn that the desktop environment or another app can already own a chord, in which case it never reaches Vellum.

Ask which behavior they want, then use `navigate_settings_tab` with `tab: "Voice"` so they can record the desktop-owned shortcut. Do not claim that `voice_config_update` changed this shortcut.

#### Legacy PTT activation setting

This setting is macOS-only. If a Mac user explicitly wants the legacy hold-to-talk setting, offer only values accepted by `voice_config_update`:

- `fn`
- `fn_shift`
- `ctrl`
- `none`

After the user chooses, call `voice_config_update` with `setting: "activation_key"` and the matching canonical value.

On Windows and Linux, do not offer or call the legacy activation setting. It has no client consumer there. Use the desktop Talk shortcut flow instead.

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

Desktop Talk starts a live voice session. Its audio is transcribed through the assistant's configured speech-to-text provider over the live voice connection. The Windows native helper provides partials only for one-shot dictation from the microphone button, and the Linux helper will do the same once it ships. Ask which surface the user tested before troubleshooting missing text.

## Troubleshooting Decision Trees

### "PTT isn't working" or "Can't record"

1. Ask whether Vellum shows a microphone permission warning and whether the recording indicator appears. If access is denied or capture does not start, follow the microphone permission flow.
2. Confirm which shortcut the user configured. Legacy PTT applies only on macOS. Verify desktop Talk in the Voice tab.
3. Apply the platform-specific checks:
   - **macOS:** Fn requires the native helper and may require Input Monitoring. The Globe key can also be assigned to macOS Dictation or the emoji picker, so suggest a custom chord if both actions fire.
   - **Windows:** Fn cannot work. A Ctrl+Shift or Alt tap requires Vellum to be focused. For use from another app, record a custom global chord and make sure no other app owns it.
   - **Linux:** Fn cannot work, and a Ctrl+Shift or Alt binding is rejected outright, so neither is a fix. Say so rather than sending the user through host permission changes, and move them to a custom chord. The chord is registered through the desktop session, so confirm no compositor or app shortcut already owns it.
4. If the user reports Speech Recognition permission as denied or not determined, call `open_system_settings` with `pane: "speech_recognition"` and the current `platform`.
5. If the Windows or Linux shortcut fires but capture does not start, restart Vellum from the tray menu and retry.

### "Talk starts but no transcript"

1. Confirm that the user started Desktop Talk and that its listening or recording indicator appears. If it does not, return to shortcut and microphone capture troubleshooting.
2. Check the active provider with `assistant config get services.stt.provider`.
3. If no usable provider is configured, help the user choose one with `voice_config_update setting="stt_provider"` and collect any required credential securely before retrying.
4. If a provider is configured, check for an invalid credential, provider outage, or a live voice connection error. A session that never connects or disconnects before transcript events is a connection path problem, not a Windows recognizer problem.
5. Confirm the configured speech-to-text language matches the speaker when the selected provider uses that setting. Do not send a Desktop Talk failure to Windows installed-language or native-helper troubleshooting.

### "One-shot dictation records but produces no text"

This path applies to the microphone button's one-shot dictation, not Desktop Talk.

1. If the user reports Speech Recognition permission as denied or unknown, open the platform's privacy page with `open_system_settings`.
2. Ask whether dictation partials appear. If capture starts without partials, troubleshoot the native helper and local recognizer.
3. On Windows, the helper uses an installed Windows speech recognizer and prefers the current Windows display language. If no matching recognizer is installed, add that language's speech feature or select an installed language.
4. On Linux, dictation runs through the native helper, which no current build ships, so it reports unavailable rather than failing silently. Confirm that is what the app showed, tell the user the feature is not available yet, and stop here. A restart cannot change the result.
5. Reduce background noise or move closer to the microphone.
6. On Windows, restart Vellum from the tray menu and retry. This relaunches Vellum and its one-shot dictation helper.

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

**Linux:**

```bash
tail -f ~/.config/Vellum*/logs/vellum.log
```

For Desktop Talk, look for live voice, WebSocket, and speech-to-text provider errors. For one-shot dictation, look for `[win-helper]`, which the Linux client currently reuses as well, plus `linux helper` from the sidecar supervisor and any `dictation`, permission, or recognizer messages. Do not ask the user to share transcript contents from logs.

## Rules

- Handle every tool-backed setting conversationally in chat.
- Use `navigate_settings_tab` for review and for the desktop-owned Talk shortcut, which must be recorded in the client.
- Use platform-specific Settings names and shortcuts.
- Be concise. Present the common choices and let the user ask for more.
- If permission is denied, acknowledge it and explain which voice features will remain unavailable.
