## Current Objective
Add voice input (hold Option key to speak task) and right-click quit to the macOS computer use menu bar app.

## Progress Summary
- App successfully controls Chrome via AX tree + Claude Sonnet 4.5 tool use — filled out Google Forms on first try
- Fixed os.Logger subsystem (`"com.vellum.vellum-assistant"` matching bundle ID), added comprehensive logging to Session and AccessibilityTree
- Added ChromeAccessibilityHelper: auto-restarts Chrome with `--force-renderer-accessibility` when web content missing from AX tree
- Aligned screen sizing with graphos: `CGDisplayBounds(CGMainDisplayID())` for logical display points
- Fixed self-window race condition with 300ms popover-close delay
- 8 custom tools (click, double_click, right_click, type_text, key, scroll, wait, done) with element_id targeting

## Active Work
Both features implemented:
1. **Voice input**: Hold Option key → start recording (mic.fill icon), release → transcribe via SFSpeechRecognizer → submit as task. VoiceInputManager.swift uses global+local flagsChanged monitors. Only triggers on Option alone (not Cmd+Option etc). First use prompts for speech recognition + microphone permissions.
2. **Right-click quit**: Right-clicking the menu bar status item shows context menu with "Quit". Uses button.sendAction(on: [.leftMouseUp, .rightMouseUp]) with NSMenu.popUp.

## Technical Context
- **Stack/Dependencies**: Swift/SwiftUI macOS 14+ app, Anthropic Messages API (Sonnet 4.5), CGEvent injection, ApplicationServices AX API, ScreenCaptureKit, HotKey package (soffes/HotKey)
- **Architecture**: Menu bar app (LSUIElement) with NSStatusItem → NSPopover for task input. Session: PERCEIVE (AX tree) → INFER (Claude) → VERIFY → EXECUTE (CGEvent) → LOG
- **Build**: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -scheme vellum-assistant -configuration Release -derivedDataPath build build`
- **Bundle ID**: `com.vellum.vellum-assistant`
- **Log stream**: `log stream --predicate 'subsystem == "com.vellum.vellum-assistant"' --level debug`
- **Constraints**: `Bundle.main.bundleIdentifier` returns nil at runtime (SwiftPM executable context), so logger uses fallback string. App uses `.accessory` activation policy (no dock icon).

## Next Steps
1. Test end-to-end voice → transcription → session flow
2. Consider adding visual feedback beyond mic icon (e.g., popover showing "Listening..." or waveform)
3. Consider on-device vs server-side speech recognition toggle in Settings

## Important Files
```
vellum-assistant/App/AppDelegate.swift - Menu bar setup, hotkey, session launching — modify for right-click menu and voice input
vellum-assistant/App/VellumAssistantApp.swift - @main entry point, Settings scene
vellum-assistant/UI/TaskInputView.swift - Text input popover UI
vellum-assistant/ComputerUse/Session.swift - Main session loop with Chrome auto-fix, logging
vellum-assistant/ComputerUse/AccessibilityTree.swift - AX tree enumeration with logging
vellum-assistant/ComputerUse/ChromeAccessibilityHelper.swift - Auto-restart Chrome with accessibility flag
vellum-assistant/ComputerUse/ScreenCapture.swift - CGDisplayBounds-based screen size
vellum-assistant/Inference/AnthropicProvider.swift - API calls, system prompt, tool call parsing
vellum-assistant/Inference/ToolDefinitions.swift - 8 tool schemas
vellum-assistant/Resources/Info-generated.plist - Xcode-generated plist (needs mic/speech entitlements)
vellum-assistant.xcodeproj/project.pbxproj - Must manually add new .swift files here
```

## Open Questions/Blockers
- Voice input is an alternative alongside the popover (hold Option anywhere to speak, or click/Cmd+Shift+G for text input)
- `Bundle.main.bundleIdentifier` is nil — new files must be added to pbxproj manually (see ChromeAccessibilityHelper pattern)
- Session logs: `~/Library/Application Support/vellum-assistant/logs/session-*.json`
